import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import {
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  getNativeGitRepository,
  readRepublicAgentDoc,
  readRepublicInboxMessages,
  sanitizeRepublicDeliberationID,
  writeRepublicContract,
  type RepublicCommonsMessage,
} from "../../shared/git-worktree"

const MESSAGE_TYPES = [
  "proposal",
  "question",
  "answer",
  "objection",
  "revision",
  "handoff",
  "consensus",
  "note",
] as const

type ToolContextLike = {
  sessionID?: string
  agent?: string
}

function getSeatID(args: { author_seat_id?: string }, context: ToolContextLike): string {
  if (args.author_seat_id) {
    return sanitizeRepublicDeliberationID(args.author_seat_id)
  }
  const agent = context.agent ?? (context.sessionID ? getSessionAgent(context.sessionID) : undefined)
  const normalizedAgent = agent ? getAgentConfigKey(agent) : "agent"
  return sanitizeRepublicDeliberationID(`${normalizedAgent}-executor`)
}

function getDeliberationID(args: { deliberation_id?: string }, context: ToolContextLike): string {
  return sanitizeRepublicDeliberationID(args.deliberation_id ?? `session-${context.sessionID ?? "unknown"}`)
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const values = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return values.length > 0 ? values : undefined
}

function formatInboxMessage(message: RepublicCommonsMessage): string {
  const lines = [
    `- ${message.timestamp ?? ""} [${message.messageType}] ${message.authorSeatID}${message.targetSeatID ? ` -> ${message.targetSeatID}` : ""}`,
  ]
  if (message.messageID) lines.push(`  id: ${message.messageID}`)
  if (message.workgroupID) lines.push(`  workgroup: ${message.workgroupID}`)
  if (message.module) lines.push(`  module: ${message.module}`)
  if (message.taskID) lines.push(`  task: ${message.taskID}`)
  if (message.files?.length) lines.push(`  files: ${message.files.join(", ")}`)
  lines.push(`  ${message.content.trim().replace(/\s+/g, " ")}`)
  return lines.join("\n")
}

function buildCommonsMessage(
  args: Record<string, unknown>,
  context: ToolContextLike,
  messageType: RepublicCommonsMessage["messageType"],
): RepublicCommonsMessage {
  const authorSeatID = getSeatID({ author_seat_id: args.author_seat_id as string | undefined }, context)
  const deliberationID = getDeliberationID({ deliberation_id: args.deliberation_id as string | undefined }, context)
  return {
    messageID: sanitizeRepublicDeliberationID(`${deliberationID}-${authorSeatID}-${messageType}-${Date.now()}`),
    deliberationID,
    channel: typeof args.channel === "string" ? args.channel : "commons",
    phase: typeof args.phase === "string" ? args.phase : "collaboration",
    authorSeatID,
    authorAgent: typeof args.author_agent === "string" ? args.author_agent : undefined,
    authorRole: typeof args.author_role === "string" ? args.author_role : undefined,
    targetSeatID: typeof args.target_seat_id === "string" ? sanitizeRepublicDeliberationID(args.target_seat_id) : undefined,
    workgroupID: typeof args.workgroup_id === "string" ? args.workgroup_id : undefined,
    module: typeof args.module === "string" ? args.module : undefined,
    taskID: typeof args.task_id === "string" ? args.task_id : undefined,
    dependsOn: safeStringArray(args.depends_on),
    supervisorSeatID: typeof args.supervisor_seat_id === "string" ? args.supervisor_seat_id : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    messageType,
    references: safeStringArray(args.references),
    files: safeStringArray(args.files),
    confidence: typeof args.confidence === "number" ? args.confidence : undefined,
    content: String(args.content ?? "").trim(),
  }
}

export function createRepublicTools(ctx: PluginInput): Record<string, ToolDefinition> {
  const republic_publish: ToolDefinition = tool({
    description:
      "Publish a Republic Commons message for agent-to-agent collaboration. Use this to ask questions, answer another seat, object, revise, hand off work, or record a proposal. Messages are stored under the Git common dir and mirrored into agent docs.",
    args: {
      message_type: tool.schema.enum(MESSAGE_TYPES).describe("Commons message type"),
      content: tool.schema.string().describe("Concise message body"),
      target_seat_id: tool.schema.string().optional().describe("Optional recipient seat, such as api-seat or republic-supervisor"),
      author_seat_id: tool.schema.string().optional().describe("Override author seat; defaults from current agent/session"),
      author_agent: tool.schema.string().optional().describe("Optional agent name"),
      author_role: tool.schema.string().optional().describe("Optional role name"),
      deliberation_id: tool.schema.string().optional().describe("Deliberation ID; defaults to current session"),
      channel: tool.schema.string().optional().describe("Commons channel, default commons"),
      phase: tool.schema.string().optional().describe("Workflow phase, default collaboration"),
      workgroup_id: tool.schema.string().optional().describe("Workgroup identifier"),
      module: tool.schema.string().optional().describe("Module or subsystem"),
      task_id: tool.schema.string().optional().describe("Related task ID"),
      depends_on: tool.schema.array(tool.schema.string()).optional().describe("Dependent workgroups or tasks"),
      references: tool.schema.array(tool.schema.string()).optional().describe("Message IDs this message responds to"),
      files: tool.schema.array(tool.schema.string()).optional().describe("Related files"),
      status: tool.schema.string().optional().describe("Optional status such as blocked, proposed, accepted"),
      confidence: tool.schema.number().optional().describe("Optional confidence score"),
    },
    execute: async (args, context) => {
      const repository = getNativeGitRepository(ctx.directory)
      if (!repository) {
        return JSON.stringify({ error: "not_git_repository" })
      }

      const message = buildCommonsMessage(args, context as ToolContextLike, args.message_type as RepublicCommonsMessage["messageType"])
      if (!message.content) {
        return JSON.stringify({ error: "empty_content" })
      }

      appendRepublicCommonsMessage(repository, message)
      appendRepublicLedgerRecord(repository, {
        deliberationID: message.deliberationID,
        phase: message.phase,
        chamber: "commons",
        seatID: message.authorSeatID,
        role: message.authorRole,
        agent: message.authorAgent,
        sessionID: (context as ToolContextLike).sessionID,
        workgroupID: message.workgroupID,
        module: message.module,
        taskID: message.taskID,
        dependsOn: message.dependsOn,
        supervisorSeatID: message.supervisorSeatID,
        status: message.status,
        confidence: message.confidence,
        files: message.files,
        summary: message.content,
      })

      return JSON.stringify({
        ok: true,
        message_id: message.messageID,
        message_type: message.messageType,
        author_seat_id: message.authorSeatID,
        target_seat_id: message.targetSeatID,
      })
    },
  })

  const republic_inbox: ToolDefinition = tool({
    description:
      "Read the current seat's Republic Commons inbox, including targeted questions, objections, handoffs, supervisor interventions, dependency gates, and related workgroup messages.",
    args: {
      seat_id: tool.schema.string().optional().describe("Seat to read; defaults from current agent/session"),
      deliberation_id: tool.schema.string().optional().describe("Optional deliberation filter"),
      workgroup_id: tool.schema.string().optional().describe("Optional workgroup filter"),
      module: tool.schema.string().optional().describe("Optional module filter"),
      limit: tool.schema.number().optional().describe("Maximum messages, default 10"),
      include_agent_doc: tool.schema.boolean().optional().describe("Include the seat markdown doc"),
    },
    execute: async (args, context) => {
      const repository = getNativeGitRepository(ctx.directory)
      if (!repository) {
        return "Error: not a git repository"
      }

      const seatID = getSeatID({ author_seat_id: args.seat_id as string | undefined }, context as ToolContextLike)
      const messages = readRepublicInboxMessages(repository, {
        seatID,
        deliberationID: typeof args.deliberation_id === "string" ? args.deliberation_id : undefined,
        workgroupID: typeof args.workgroup_id === "string" ? args.workgroup_id : undefined,
        module: typeof args.module === "string" ? args.module : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      })
      const parts = [`# Republic Inbox: ${seatID}`, "", messages.length > 0 ? messages.map(formatInboxMessage).join("\n\n") : "No relevant messages."]
      if (args.include_agent_doc === true) {
        const doc = readRepublicAgentDoc(repository, seatID).trim()
        parts.push("", "## Agent Doc", doc || "No agent doc entries yet.")
      }
      return parts.join("\n")
    },
  })

  const republic_contract: ToolDefinition = tool({
    description:
      "Write or revise a workgroup contract before adjacent modules implement against each other. Use for API shape, test boundaries, data schemas, handoff rules, and shared responsibilities.",
    args: {
      workgroup_id: tool.schema.string().describe("Workgroup ID, for example wg-src-api"),
      title: tool.schema.string().describe("Contract title"),
      content: tool.schema.string().describe("Contract body"),
      module: tool.schema.string().optional().describe("Module or subsystem"),
      status: tool.schema.string().optional().describe("proposed, accepted, revised, blocked"),
      author_seat_id: tool.schema.string().optional().describe("Author seat; defaults from current agent/session"),
      target_seat_id: tool.schema.string().optional().describe("Optional recipient seat"),
      deliberation_id: tool.schema.string().optional().describe("Deliberation ID; defaults to current session"),
      files: tool.schema.array(tool.schema.string()).optional().describe("Files governed by this contract"),
      references: tool.schema.array(tool.schema.string()).optional().describe("Message IDs this contract revises or answers"),
    },
    execute: async (args, context) => {
      const repository = getNativeGitRepository(ctx.directory)
      if (!repository) {
        return JSON.stringify({ error: "not_git_repository" })
      }

      const authorSeatID = getSeatID({ author_seat_id: args.author_seat_id as string | undefined }, context as ToolContextLike)
      const workgroupID = String(args.workgroup_id)
      const contractPath = writeRepublicContract(repository, {
        workgroupID,
        module: typeof args.module === "string" ? args.module : undefined,
        title: String(args.title),
        content: String(args.content),
        authorSeatID,
        status: typeof args.status === "string" ? args.status : undefined,
        files: safeStringArray(args.files),
      })
      const message = buildCommonsMessage(
        {
          ...args,
          content: `Contract ${args.status ?? "proposed"}: ${args.title}\n\n${args.content}`,
          message_type: "contract",
          author_seat_id: authorSeatID,
          workgroup_id: workgroupID,
          phase: "contract",
          channel: "contracts",
        },
        context as ToolContextLike,
        "contract",
      )
      appendRepublicCommonsMessage(repository, message)
      appendRepublicLedgerRecord(repository, {
        deliberationID: message.deliberationID,
        phase: "contract",
        chamber: "commons",
        seatID: authorSeatID,
        sessionID: (context as ToolContextLike).sessionID,
        workgroupID,
        module: message.module,
        taskID: message.taskID,
        status: message.status,
        files: message.files,
        summary: message.content,
      })

      return JSON.stringify({
        ok: true,
        message_id: message.messageID,
        contract_path: contractPath,
        workgroup_id: workgroupID,
      })
    },
  })

  return {
    republic_publish,
    republic_inbox,
    republic_contract,
  }
}
