import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import type { RepublicConfig } from "../../config"
import type { BackgroundManager } from "../../features/background-agent"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { normalizeSDKResponse } from "../../shared"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import {
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  getNativeGitRepository,
  readRepublicAgentDoc,
  readRepublicInboxMessages,
  sanitizeRepublicDeliberationID,
  writeRepublicContract,
  type NativeGitRepository,
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

const DISPATCHABLE_MESSAGE_TYPES = new Set(["question", "handoff", "objection"])
const SUPERVISOR_REVIEW_STATUSES = new Set(["blocked", "review-required"])

type ToolContextLike = {
  sessionID?: string
  messageID?: string
  agent?: string
  directory?: string
  worktree?: string
  path?: {
    cwd?: string
    root?: string
  }
}

type RepublicToolOptions = {
  manager?: Pick<BackgroundManager, "launch">
  config?: RepublicConfig
}

type AgentInfo = {
  name: string
  mode?: "subagent" | "primary" | "all"
}

type DispatchAgentResolution = {
  requestedAgent: string
  runtimeAgent: string
}

function getToolRepository(ctx: PluginInput, context: ToolContextLike): NativeGitRepository | null {
  const candidates = [
    context.directory,
    context.worktree,
    context.path?.cwd,
    context.path?.root,
    ctx.directory,
  ].filter((directory): directory is string => typeof directory === "string" && directory.length > 0)

  for (const directory of candidates) {
    const repository = getNativeGitRepository(directory)
    if (repository) {
      return repository
    }
  }

  return null
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

function resolveDispatchAgent(
  targetSeatID: string | undefined,
  args: Record<string, unknown>,
  config: RepublicConfig | undefined,
): string {
  const explicitAgent = typeof args.target_agent === "string" ? args.target_agent.trim() : ""
  if (explicitAgent) {
    return explicitAgent
  }

  const scheduler = config?.scheduler
  const sanitizedTarget = targetSeatID ? sanitizeRepublicDeliberationID(targetSeatID) : ""
  const mappedAgent = sanitizedTarget ? scheduler?.seat_agents?.[sanitizedTarget] : undefined
  if (mappedAgent) {
    return mappedAgent
  }

  const lowerTarget = sanitizedTarget.toLowerCase()
  if (lowerTarget.includes("supervisor")) {
    return scheduler?.supervisor_agent ?? "hephaestus"
  }

  for (const agent of ["atlas", "prometheus", "hephaestus", "sisyphus"]) {
    if (lowerTarget.includes(agent)) {
      return agent
    }
  }

  return scheduler?.default_agent ?? "sisyphus"
}

async function getRuntimeAgentNames(ctx: PluginInput): Promise<string[]> {
  const app = (ctx as { client?: { app?: { agents?: () => Promise<unknown> } } }).client?.app
  if (!app?.agents) {
    return []
  }

  try {
    const agentsResult = await app.agents()
    const agents = normalizeSDKResponse(agentsResult, [] as AgentInfo[], {
      preferResponseOnMissingData: true,
    })
    return agents
      .filter((agent) => agent && typeof agent.name === "string" && agent.name.trim().length > 0 && agent.mode !== "primary")
      .map((agent) => agent.name.trim().toLowerCase())
  } catch {
    return []
  }
}

async function resolveRuntimeDispatchAgent(args: {
  ctx: PluginInput
  requestedAgent: string
  config?: RepublicConfig
}): Promise<DispatchAgentResolution> {
  const { ctx, requestedAgent, config } = args
  const requested = requestedAgent.trim().toLowerCase()
  const runtimeAgents = await getRuntimeAgentNames(ctx)
  if (runtimeAgents.length === 0 || runtimeAgents.includes(requested)) {
    return { requestedAgent, runtimeAgent: requestedAgent }
  }

  const candidates = [
    config?.scheduler?.default_agent,
    "general",
    "explore",
    "oracle",
    "librarian",
  ]
    .filter((agent): agent is string => typeof agent === "string" && agent.trim().length > 0)
    .map((agent) => agent.trim().toLowerCase())

  for (const candidate of candidates) {
    if (runtimeAgents.includes(candidate)) {
      return { requestedAgent, runtimeAgent: candidate }
    }
  }

  return { requestedAgent, runtimeAgent: requestedAgent }
}

function shouldAutoDispatch(
  message: RepublicCommonsMessage,
  config: RepublicConfig | undefined,
): boolean {
  if ((config?.enabled ?? true) === false || (config?.mode ?? "advisory") === "manual") {
    return false
  }
  const scheduler = config?.scheduler
  if ((scheduler?.enabled ?? true) === false || (scheduler?.auto_dispatch ?? true) === false) {
    return false
  }
  if (!message.targetSeatID || message.targetSeatID === message.authorSeatID) {
    return false
  }
  const configuredTypes = new Set(scheduler?.message_types ?? ["question", "handoff", "objection"])
  return configuredTypes.has(message.messageType as "question" | "handoff" | "objection")
    && DISPATCHABLE_MESSAGE_TYPES.has(message.messageType)
}

function shouldAutoDispatchSupervisor(
  message: RepublicCommonsMessage,
  config: RepublicConfig | undefined,
): boolean {
  if ((config?.enabled ?? true) === false || (config?.mode ?? "advisory") === "manual") {
    return false
  }
  if ((config?.supervisor?.intervention ?? true) === false) {
    return false
  }
  const scheduler = config?.scheduler
  if ((scheduler?.enabled ?? true) === false || (scheduler?.auto_dispatch ?? true) === false) {
    return false
  }
  if (message.authorSeatID === "republic-supervisor" || message.targetSeatID === "republic-supervisor") {
    return false
  }
  return message.messageType === "objection"
    || (typeof message.status === "string" && SUPERVISOR_REVIEW_STATUSES.has(message.status))
}

function buildDispatchPrompt(message: RepublicCommonsMessage, options: DispatchAgentResolution & { maxMessages: number }): string {
  const targetSeatID = message.targetSeatID ?? "target-seat"
  const responseType = message.messageType === "question" ? "answer" : "revision"
  const lines = [
    `You are Republic seat "${targetSeatID}".`,
    `Requested OMO role: "${options.requestedAgent}". Runtime OpenCode agent: "${options.runtimeAgent}".`,
    "A targeted Commons message needs an active response. This session was launched by the Republic scheduler.",
    "",
    "Incoming Commons message:",
    `- id: ${message.messageID ?? "unknown"}`,
    `- type: ${message.messageType}`,
    `- from: ${message.authorSeatID}`,
    `- deliberation: ${message.deliberationID}`,
    message.workgroupID ? `- workgroup: ${message.workgroupID}` : undefined,
    message.module ? `- module: ${message.module}` : undefined,
    message.taskID ? `- task: ${message.taskID}` : undefined,
    message.files?.length ? `- files: ${message.files.join(", ")}` : undefined,
    "",
    message.content.trim(),
    "",
    "Protocol:",
    `1. Read republic_inbox for seat "${targetSeatID}" if you need more context.`,
    `2. Respond with republic_publish(message_type="${responseType}", author_seat_id="${targetSeatID}", target_seat_id="${message.authorSeatID}", references=["${message.messageID ?? ""}"], deliberation_id="${message.deliberationID}", content="...").`,
    "3. If you disagree, publish an objection or revision instead of silently proceeding.",
    "4. If shared API/schema/test boundaries are involved, use republic_contract before implementation.",
    "5. Do not edit files unless this is explicitly a handoff/implementation request; any edits will be tracked by native Git.",
    "6. Stop after publishing the response or handoff.",
    "",
    `Keep the response focused. Use at most ${options.maxMessages} relevant Commons messages as context.`,
  ]

  return lines.filter((line): line is string => typeof line === "string").join("\n")
}

function buildSupervisorReviewPrompt(
  message: RepublicCommonsMessage,
  options: DispatchAgentResolution & { maxMessages: number },
): string {
  const lines = [
    'You are Republic supervisor seat "republic-supervisor".',
    `Requested OMO role: "${options.requestedAgent}". Runtime OpenCode agent: "${options.runtimeAgent}".`,
    "A Commons governance event needs active review. This session was launched by the Republic scheduler.",
    "",
    "Governance event:",
    `- id: ${message.messageID ?? "unknown"}`,
    `- type: ${message.messageType}`,
    `- status: ${message.status ?? "none"}`,
    `- from: ${message.authorSeatID}`,
    message.targetSeatID ? `- to: ${message.targetSeatID}` : undefined,
    `- deliberation: ${message.deliberationID}`,
    message.workgroupID ? `- workgroup: ${message.workgroupID}` : undefined,
    message.module ? `- module: ${message.module}` : undefined,
    message.taskID ? `- task: ${message.taskID}` : undefined,
    message.files?.length ? `- files: ${message.files.join(", ")}` : undefined,
    message.references?.length ? `- references: ${message.references.join(", ")}` : undefined,
    "",
    message.content.trim(),
    "",
    "Protocol:",
    '1. Read republic_inbox for seat "republic-supervisor" if you need more context.',
    `2. Decide whether this event needs consensus, revision, handoff, or a blocking objection.`,
    `3. Publish the decision with republic_publish(author_seat_id="republic-supervisor", references=["${message.messageID ?? ""}"], deliberation_id="${message.deliberationID}", message_type="consensus" or "revision" or "objection", content="...").`,
    "4. If adjacent modules need an interface rule, write or revise a republic_contract.",
    "5. Do not edit files unless the governance decision explicitly requires it; any edits will be tracked by native Git.",
    "6. Stop after publishing the supervisor decision.",
    "",
    `Keep the review focused. Use at most ${options.maxMessages} relevant Commons messages as context.`,
  ]

  return lines.filter((line): line is string => typeof line === "string").join("\n")
}

async function dispatchRepublicSeatResponse(args: {
  repository: NativeGitRepository
  message: RepublicCommonsMessage
  context: ToolContextLike
  toolArgs: Record<string, unknown>
  manager: Pick<BackgroundManager, "launch">
  config?: RepublicConfig
  ctx: PluginInput
}): Promise<{ taskID: string; agent: string; requested_agent?: string } | null> {
  const { repository, message, context, toolArgs, manager, config, ctx } = args
  if (!shouldAutoDispatch(message, config) || !context.sessionID) {
    return null
  }

  const requestedAgent = resolveDispatchAgent(message.targetSeatID, toolArgs, config)
  const dispatchAgent = await resolveRuntimeDispatchAgent({ ctx, requestedAgent, config })
  const prompt = buildDispatchPrompt(message, {
    ...dispatchAgent,
    maxMessages: config?.scheduler?.prompt_max_messages ?? 8,
  })
  const task = await manager.launch({
    description: `Republic response for ${message.targetSeatID}`,
    prompt,
    agent: dispatchAgent.runtimeAgent,
    parentSessionId: context.sessionID,
    parentMessageId: context.messageID ?? message.messageID ?? "",
    parentAgent: context.agent,
    category: "republic-response",
  })

  const agentSummary = dispatchAgent.runtimeAgent === dispatchAgent.requestedAgent
    ? dispatchAgent.runtimeAgent
    : `${dispatchAgent.runtimeAgent} (requested ${dispatchAgent.requestedAgent})`
  const summary = `Republic scheduler dispatched ${message.targetSeatID} via ${agentSummary} to respond to ${message.messageID ?? "the targeted Commons message"} as background task ${task.id}.`
  appendRepublicCommonsMessage(repository, {
    deliberationID: message.deliberationID,
    channel: "scheduler",
    phase: "dispatch",
    authorSeatID: "republic-scheduler",
    authorAgent: "republic-scheduler",
    authorRole: "scheduler",
    targetSeatID: message.targetSeatID,
    workgroupID: message.workgroupID,
    module: message.module,
    taskID: task.id,
    status: "dispatched",
    messageType: "status",
    references: message.messageID ? [message.messageID] : undefined,
    files: message.files,
    content: summary,
  })
  appendRepublicLedgerRecord(repository, {
    deliberationID: message.deliberationID,
    phase: "dispatch",
    chamber: "scheduler",
    seatID: "republic-scheduler",
    role: "scheduler",
    agent: "republic-scheduler",
    sessionID: context.sessionID,
    workgroupID: message.workgroupID,
    module: message.module,
    taskID: task.id,
    status: "dispatched",
    files: message.files,
    summary,
  })

  return {
    taskID: task.id,
    agent: dispatchAgent.runtimeAgent,
    ...(dispatchAgent.runtimeAgent !== dispatchAgent.requestedAgent
      ? { requested_agent: dispatchAgent.requestedAgent }
      : {}),
  }
}

async function dispatchRepublicSupervisorReview(args: {
  repository: NativeGitRepository
  message: RepublicCommonsMessage
  context: ToolContextLike
  manager: Pick<BackgroundManager, "launch">
  config?: RepublicConfig
  ctx: PluginInput
}): Promise<{ taskID: string; agent: string; requested_agent?: string } | null> {
  const { repository, message, context, manager, config, ctx } = args
  if (!shouldAutoDispatchSupervisor(message, config) || !context.sessionID) {
    return null
  }

  const requestedAgent = config?.scheduler?.supervisor_agent ?? "hephaestus"
  const dispatchAgent = await resolveRuntimeDispatchAgent({ ctx, requestedAgent, config })
  const prompt = buildSupervisorReviewPrompt(message, {
    ...dispatchAgent,
    maxMessages: config?.scheduler?.prompt_max_messages ?? 8,
  })
  const task = await manager.launch({
    description: `Republic supervisor review for ${message.messageID ?? message.messageType}`,
    prompt,
    agent: dispatchAgent.runtimeAgent,
    parentSessionId: context.sessionID,
    parentMessageId: context.messageID ?? message.messageID ?? "",
    parentAgent: context.agent,
    category: "republic-supervisor",
  })

  const agentSummary = dispatchAgent.runtimeAgent === dispatchAgent.requestedAgent
    ? dispatchAgent.runtimeAgent
    : `${dispatchAgent.runtimeAgent} (requested ${dispatchAgent.requestedAgent})`
  const summary = `Republic scheduler dispatched supervisor review via ${agentSummary} for ${message.messageID ?? "the governance event"} as background task ${task.id}.`
  appendRepublicCommonsMessage(repository, {
    deliberationID: message.deliberationID,
    channel: "scheduler",
    phase: "supervisor-dispatch",
    authorSeatID: "republic-scheduler",
    authorAgent: "republic-scheduler",
    authorRole: "scheduler",
    targetSeatID: "republic-supervisor",
    workgroupID: message.workgroupID,
    module: message.module,
    taskID: task.id,
    status: "dispatched",
    messageType: "status",
    references: message.messageID ? [message.messageID] : undefined,
    files: message.files,
    content: summary,
  })
  appendRepublicLedgerRecord(repository, {
    deliberationID: message.deliberationID,
    phase: "supervisor-dispatch",
    chamber: "scheduler",
    seatID: "republic-scheduler",
    role: "scheduler",
    agent: "republic-scheduler",
    sessionID: context.sessionID,
    workgroupID: message.workgroupID,
    module: message.module,
    taskID: task.id,
    status: "dispatched",
    files: message.files,
    summary,
  })

  return {
    taskID: task.id,
    agent: dispatchAgent.runtimeAgent,
    ...(dispatchAgent.runtimeAgent !== dispatchAgent.requestedAgent
      ? { requested_agent: dispatchAgent.requestedAgent }
      : {}),
  }
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

export function createRepublicTools(ctx: PluginInput, options: RepublicToolOptions = {}): Record<string, ToolDefinition> {
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
      target_agent: tool.schema.string().optional().describe("Optional preferred OMO/runtime agent to dispatch for the target seat"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
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

      let dispatch: { taskID: string; agent: string; requested_agent?: string } | null = null
      let supervisorDispatch: { taskID: string; agent: string; requested_agent?: string } | null = null
      if (options.manager) {
        dispatch = await dispatchRepublicSeatResponse({
          repository,
          message,
          context: context as ToolContextLike,
          toolArgs: args,
          manager: options.manager,
          config: options.config,
          ctx,
        })
        supervisorDispatch = await dispatchRepublicSupervisorReview({
          repository,
          message,
          context: context as ToolContextLike,
          manager: options.manager,
          config: options.config,
          ctx,
        })
      }

      return JSON.stringify({
        ok: true,
        message_id: message.messageID,
        message_type: message.messageType,
        author_seat_id: message.authorSeatID,
        target_seat_id: message.targetSeatID,
        ...(dispatch ? { dispatch } : {}),
        ...(supervisorDispatch ? { supervisor_dispatch: supervisorDispatch } : {}),
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
      const repository = getToolRepository(ctx, context as ToolContextLike)
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
      const repository = getToolRepository(ctx, context as ToolContextLike)
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
