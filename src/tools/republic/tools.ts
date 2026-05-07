import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { existsSync, readFileSync } from "node:fs"
import type { RepublicConfig } from "../../config"
import { RepublicConfigSchema } from "../../config/schema"
import type { BackgroundManager } from "../../features/background-agent"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { maybeOpenRepublicDashboard } from "../../republic/dashboard-launcher"
import { normalizeSDKResponse } from "../../shared"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import {
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  appendRepublicSchedulerQueueRecord,
  appendRepublicSeatMemory,
  getRepublicContractPath,
  getNativeGitRepository,
  initializeRepublicTeam,
  readRepublicAgentDoc,
  readRepublicCommonsMessages,
  readRepublicInboxMessages,
  readRepublicSeatMemory,
  readRepublicSeatState,
  readRepublicTeamManifest,
  readRepublicTeamPhase,
  sanitizeRepublicDeliberationID,
  writeRepublicSeatState,
  writeRepublicTeamPhase,
  writeRepublicContract,
  type NativeGitRepository,
  type RepublicCommonsMessage,
  type RepublicTeamSeatDefinition,
} from "../../shared/git-worktree"
import { allocateRepublicTeam } from "./seat-allocator"

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
const DEFAULT_WAIT_MESSAGE_TYPES = ["answer", "revision", "objection", "consensus", "contract", "handoff"]
const TEAM_MODELS = ["single", "advisory", "parliament", "squad", "parliament_squad"] as const
const SEAT_ALLOCATIONS = ["auto", "count", "explicit"] as const
const TEAM_PHASES = ["planning", "execution", "review", "idle"] as const
const TEAM_STATUSES = ["planned", "in-progress", "blocked", "review", "done"] as const
const SEAT_STATUSES = ["standby", "running", "waiting", "blocked", "done", "error"] as const
const REPUBLIC_HARD_DEPENDENCY_RULE =
  "Do not create or update dependencies, lockfiles, generated scripts, global config, or helper files unless the objective or a locked contract explicitly names them."

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
  dashboardOpener?: (target: string) => boolean
}

type AgentInfo = {
  name: string
  mode?: "subagent" | "primary" | "all"
}

type DispatchAgentResolution = {
  requestedAgent: string
  runtimeAgent: string
}

type QueuedDispatchResult = {
  dispatch_id: string
  target_seat_id: string
  requested_agent?: string
  reason: string
}

type LockedContractContext = {
  id: string
  path: string
  found: boolean
  content?: string
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

function getContextFallbackSeatID(context: ToolContextLike): string {
  const agent = context.agent ?? (context.sessionID ? getSessionAgent(context.sessionID) : undefined)
  const normalizedAgent = agent ? getAgentConfigKey(agent) : "agent"
  return sanitizeRepublicDeliberationID(`${normalizedAgent}-executor`)
}

function getManifestSupervisorSeatID(manifest: ReturnType<typeof readRepublicTeamManifest>): string | undefined {
  return manifest?.seats.find((seat) => seat.seatID === "republic-supervisor")?.seatID
    ?? manifest?.seats.find((seat) => seat.role === "supervisor")?.seatID
}

function getSeatID(
  args: { author_seat_id?: string },
  context: ToolContextLike,
  repository?: NativeGitRepository | null,
): string {
  if (args.author_seat_id) {
    return sanitizeRepublicDeliberationID(args.author_seat_id)
  }
  const fallbackSeatID = getContextFallbackSeatID(context)
  const manifest = repository ? readRepublicTeamManifest(repository) : null
  if (!manifest) {
    return fallbackSeatID
  }
  if (manifest.seats.some((seat) => seat.seatID === fallbackSeatID)) {
    return fallbackSeatID
  }

  const agent = context.agent ?? (context.sessionID ? getSessionAgent(context.sessionID) : undefined)
  const normalizedAgent = agent ? getAgentConfigKey(agent) : undefined
  const matchingRuntimeSeats = normalizedAgent && normalizedAgent !== "general"
    ? manifest.seats.filter((seat) => seat.runtimeAgent && getAgentConfigKey(seat.runtimeAgent) === normalizedAgent)
    : []
  if (matchingRuntimeSeats.length === 1 && matchingRuntimeSeats[0]) {
    return matchingRuntimeSeats[0].seatID
  }

  return getManifestSupervisorSeatID(manifest) ?? "republic-orchestrator"
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

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, value))
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
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

function tailText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  return value.slice(value.length - maxChars)
}

function normalizeLockedContractID(contractID: string): string {
  const normalized = contractID.replace(/\\/g, "/").split("/").pop() ?? contractID
  return normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized
}

function readLockedContractContexts(
  repository: NativeGitRepository,
  lockedContracts: string[] | undefined,
  maxChars: number,
): LockedContractContext[] {
  return (lockedContracts ?? []).map((contractID) => {
    const normalizedID = normalizeLockedContractID(contractID)
    const path = getRepublicContractPath(repository, normalizedID)
    if (!existsSync(path)) {
      return { id: normalizedID, path, found: false }
    }
    const content = maxChars > 0 ? tailText(readFileSync(path, "utf-8"), maxChars) : undefined
    return { id: normalizedID, path, found: true, content }
  })
}

function buildConstrainedOperatingRules(args: {
  phase: typeof TEAM_PHASES[number]
  seat?: RepublicTeamSeatDefinition
  labeledContext?: boolean
}): string[] {
  const { phase, seat } = args
  const scope = [
    seat?.workgroupID ? `workgroup=${seat.workgroupID}` : undefined,
    seat?.module ? `module=${seat.module}` : undefined,
  ].filter((part): part is string => typeof part === "string")
  const dependencyRule = args.labeledContext === false
    ? `4. ${REPUBLIC_HARD_DEPENDENCY_RULE}`
    : `4. hard_dependency_rule: ${REPUBLIC_HARD_DEPENDENCY_RULE}`
  return [
    "Constrained operating rules:",
    scope.length ? `1. Treat this seat scope as authoritative: ${scope.join(", ")}.` : "1. Treat the current seat scope as authoritative.",
    "2. Work in one bounded step at a time; if the next step is unclear, publish a targeted question before editing.",
    "3. Do not invent substitute field names, status values, file paths, or environment variables when the objective or contracts already name them.",
    dependencyRule,
    phase === "execution"
      ? "5. Before execution edits, keep the intended file set inside this seat's workgroup; if another workgroup is needed, publish a handoff or objection and stop."
      : "5. Keep outputs in Republic tools during planning/review; do not modify project files from this phase.",
    phase === "execution"
      ? "6. After execution edits, run the smallest relevant verification named by the objective/contracts and publish the result or blocker."
      : "6. Prefer concise proposals, questions, objections, revisions, or contracts that other seats can answer directly.",
  ]
}

function findReferencedResponses(args: {
  repository: NativeGitRepository
  messageID: string
  deliberationID?: string
  messageTypes: Set<string>
}): RepublicCommonsMessage[] {
  return readRepublicCommonsMessages(args.repository, args.deliberationID)
    .filter((message) => (message.references ?? []).includes(args.messageID))
    .filter((message) => args.messageTypes.has(message.messageType))
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

function createSchedulerDispatchID(
  message: RepublicCommonsMessage,
  queueType: "seat-response" | "supervisor-review",
  status: "queued" | "dispatched",
): string {
  return sanitizeRepublicDeliberationID([
    message.deliberationID,
    queueType,
    message.targetSeatID ?? "republic-supervisor",
    message.messageID ?? Date.now(),
    status,
    Date.now(),
  ].join("-")).slice(0, 140)
}

function appendSchedulerQueueRecord(args: {
  repository: NativeGitRepository
  message: RepublicCommonsMessage
  queueType: "seat-response" | "supervisor-review"
  status: "queued" | "dispatched"
  reason?: string
  targetSeatID?: string
  requestedAgent?: string
  runtimeAgent?: string
  taskID?: string
  summary: string
}): string {
  const dispatchID = createSchedulerDispatchID(args.message, args.queueType, args.status)
  appendRepublicSchedulerQueueRecord(args.repository, {
    dispatchID,
    queueType: args.queueType,
    status: args.status,
    reason: args.reason,
    deliberationID: args.message.deliberationID,
    phase: args.message.phase,
    sourceMessageID: args.message.messageID,
    sourceMessageType: args.message.messageType,
    targetSeatID: args.targetSeatID,
    requestedAgent: args.requestedAgent,
    runtimeAgent: args.runtimeAgent,
    taskID: args.taskID,
    workgroupID: args.message.workgroupID,
    module: args.message.module,
    files: args.message.files,
    references: args.message.references,
    summary: args.summary,
  })
  return dispatchID
}

function queueRepublicSeatDispatch(args: {
  repository: NativeGitRepository
  message: RepublicCommonsMessage
  toolArgs: Record<string, unknown>
  config?: RepublicConfig
  reason: string
}): QueuedDispatchResult | null {
  if (!shouldAutoDispatch(args.message, args.config)) {
    return null
  }

  const requestedAgent = resolveDispatchAgent(args.message.targetSeatID, args.toolArgs, args.config)
  const summary = `Republic scheduler queued ${args.message.targetSeatID} for ${args.message.messageID ?? "the targeted Commons message"} because ${args.reason}.`
  const dispatchID = appendSchedulerQueueRecord({
    repository: args.repository,
    message: args.message,
    queueType: "seat-response",
    status: "queued",
    reason: args.reason,
    targetSeatID: args.message.targetSeatID,
    requestedAgent,
    summary,
  })

  return {
    dispatch_id: dispatchID,
    target_seat_id: args.message.targetSeatID ?? "",
    requested_agent: requestedAgent,
    reason: args.reason,
  }
}

function queueRepublicSupervisorDispatch(args: {
  repository: NativeGitRepository
  message: RepublicCommonsMessage
  config?: RepublicConfig
  reason: string
}): QueuedDispatchResult | null {
  if (!shouldAutoDispatchSupervisor(args.message, args.config)) {
    return null
  }

  const requestedAgent = args.config?.scheduler?.supervisor_agent ?? "hephaestus"
  const summary = `Republic scheduler queued supervisor review for ${args.message.messageID ?? "the governance event"} because ${args.reason}.`
  const dispatchID = appendSchedulerQueueRecord({
    repository: args.repository,
    message: args.message,
    queueType: "supervisor-review",
    status: "queued",
    reason: args.reason,
    targetSeatID: "republic-supervisor",
    requestedAgent,
    summary,
  })

  return {
    dispatch_id: dispatchID,
    target_seat_id: "republic-supervisor",
    requested_agent: requestedAgent,
    reason: args.reason,
  }
}

function buildRoundPrompt(args: {
  seat: RepublicTeamSeatDefinition
  phase: typeof TEAM_PHASES[number]
  deliberationID: string
  goal: string
  round: number
  lockedContracts: string[]
  blockedBy: string[]
  lockedContractContext: LockedContractContext[]
  requestedAgent: string
  runtimeAgent: string
  labeledContext: boolean
}): string {
  const { seat, phase, deliberationID, goal, round, lockedContracts, blockedBy, lockedContractContext, requestedAgent, runtimeAgent, labeledContext } = args
  const allowedEdit = phase === "execution"
  const contractLines = lockedContractContext.flatMap((contract) => [
    `### ${contract.id}`,
    `path: ${contract.path}`,
    contract.found && contract.content
      ? ["```contract", contract.content.trim(), "```"].join("\n")
      : "missing: contract file was not found at this path",
    "",
  ])
  const lines = [
    `You are persistent Republic seat "${seat.seatID}".`,
    `Requested OMO role: "${requestedAgent}". Runtime OpenCode agent: "${runtimeAgent}".`,
    `Current Republic phase: ${phase}. Round: ${round}.`,
    `Deliberation: ${deliberationID}.`,
    seat.role ? `Seat role: ${seat.role}.` : undefined,
    seat.workgroupID ? `Workgroup: ${seat.workgroupID}.` : undefined,
    seat.module ? `Module: ${seat.module}.` : undefined,
    seat.reason ? `Allocation reason: ${seat.reason}.` : undefined,
    lockedContracts.length ? `Locked contracts: ${lockedContracts.join(", ")}.` : undefined,
    blockedBy.length ? `Known blockers: ${blockedBy.join(", ")}.` : undefined,
    lockedContractContext.length
      ? "Locked contract files live under the Git common dir, not the worktree. Use these paths/excerpts before asking where contracts are:"
      : undefined,
    ...contractLines,
    "",
    "Round objective:",
    goal.trim(),
    "",
    "Authority rules:",
    "1. Treat the Round objective and locked contracts as the source of truth.",
    "2. Preserve exact field names, type names, file paths, and environment variable names from the objective/contracts.",
    "3. If you need a new name or shape not present in the objective/contracts, publish it as a proposal or targeted question; do not lock it as consensus silently.",
    "4. Before writing or revising a contract, quote the exact objective/contract terms that justify it.",
    "5. You are executing as this Republic seat. Do not create a separate OMO subagent plan or delegate this seat's responsibility through task/call_omo_agent; coordinate through Republic Commons and ask the supervisor or adjacent seats when needed.",
    "",
    ...buildConstrainedOperatingRules({ phase, seat, labeledContext }),
    "",
    "Protocol:",
    `1. Call republic_seat_update(seat_id="${seat.seatID}", status="running", phase="${phase}", deliberation_id="${deliberationID}", memory="...") when you start.`,
    `2. Call republic_team_status(seat_id="${seat.seatID}", deliberation_id="${deliberationID}", include_memory=true) and republic_inbox(seat_id="${seat.seatID}", deliberation_id="${deliberationID}", include_agent_doc=true) before deciding.`,
    phase === "planning"
      ? `3. Publish a proposal, question, objection, or revision with republic_publish(author_seat_id="${seat.seatID}", deliberation_id="${deliberationID}", phase="planning", ...). If your module touches another module, ask the relevant seat instead of guessing.`
      : undefined,
    phase === "execution"
      ? `3. Implement only after checking locked contracts and relevant inbox. If an interface/schema/test boundary is unclear, publish a targeted question and call republic_wait before editing.`
      : undefined,
    phase === "review"
      ? `3. Review the current Commons, contracts, native-git evidence, and seat states. Publish consensus, revision, or objection with concrete blockers.`
      : undefined,
    phase === "idle"
      ? `3. Summarize whether this seat has pending work and publish a status or handoff if needed.`
      : undefined,
    `4. Use republic_contract before adjacent modules depend on shared API shape, data schema, test boundary, or handoff rules.`,
    `5. If blocked, call republic_seat_update(seat_id="${seat.seatID}", status="blocked" or "waiting", waiting_on=[...], deliberation_id="${deliberationID}", memory="...").`,
    `6. When finished with this round, call republic_seat_update(seat_id="${seat.seatID}", status="done", phase="${phase}", deliberation_id="${deliberationID}", memory="...").`,
    allowedEdit
      ? "7. Execution edits are allowed only when they follow locked contracts or explicit Commons consensus; all edits are tracked by native Git."
      : "7. Do not edit project files in this round; publish planning/review outputs through Republic tools.",
    "8. Stop after completing the round protocol.",
  ]

  return lines.filter((line): line is string => typeof line === "string").join("\n")
}

function selectRoundSeats(args: {
  seats: RepublicTeamSeatDefinition[]
  phase: typeof TEAM_PHASES[number]
  explicitSeatIDs?: string[]
  workgroupID?: string
  includeSupervisor: boolean
  maxSeats: number
}): RepublicTeamSeatDefinition[] {
  const explicitSeatIDs = new Set(args.explicitSeatIDs?.map(sanitizeRepublicDeliberationID) ?? [])
  const supervisorSeats = args.seats.filter((seat) => seat.role === "supervisor")
  const nonSupervisorSeats = args.seats.filter((seat) => seat.role !== "supervisor")
  const selected = nonSupervisorSeats.filter((seat) => {
    if (explicitSeatIDs.size > 0 && !explicitSeatIDs.has(seat.seatID)) {
      return false
    }
    if (args.workgroupID && seat.workgroupID !== args.workgroupID) {
      return false
    }
    if (explicitSeatIDs.size > 0) {
      return true
    }
    return seat.phase === args.phase
  })

  const phaseMatched = selected.length > 0
    ? selected
    : nonSupervisorSeats.filter((seat) => !args.workgroupID || seat.workgroupID === args.workgroupID)
  if (!args.includeSupervisor || supervisorSeats.length === 0) {
    return phaseMatched.slice(0, args.maxSeats)
  }

  const supervisor = supervisorSeats[0]
  const nonSupervisorLimit = Math.max(0, args.maxSeats - 1)
  return [
    ...phaseMatched.slice(0, nonSupervisorLimit),
    supervisor,
  ].slice(0, args.maxSeats)
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
  appendSchedulerQueueRecord({
    repository,
    message,
    queueType: "seat-response",
    status: "dispatched",
    targetSeatID: message.targetSeatID,
    requestedAgent: dispatchAgent.requestedAgent,
    runtimeAgent: dispatchAgent.runtimeAgent,
    taskID: task.id,
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
  appendSchedulerQueueRecord({
    repository,
    message,
    queueType: "supervisor-review",
    status: "dispatched",
    targetSeatID: "republic-supervisor",
    requestedAgent: dispatchAgent.requestedAgent,
    runtimeAgent: dispatchAgent.runtimeAgent,
    taskID: task.id,
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
  repository?: NativeGitRepository | null,
): RepublicCommonsMessage {
  const authorSeatID = getSeatID({ author_seat_id: args.author_seat_id as string | undefined }, context, repository)
  const manifest = repository ? readRepublicTeamManifest(repository) : null
  const authorDefinition = manifest?.seats.find((seat) => seat.seatID === authorSeatID)
  const deliberationID = getDeliberationID({ deliberation_id: args.deliberation_id as string | undefined }, context)
  return {
    messageID: sanitizeRepublicDeliberationID(`${deliberationID}-${authorSeatID}-${messageType}-${Date.now()}`),
    deliberationID,
    channel: typeof args.channel === "string" ? args.channel : "commons",
    phase: typeof args.phase === "string" ? args.phase : "collaboration",
    authorSeatID,
    authorAgent: typeof args.author_agent === "string" ? args.author_agent : authorDefinition?.runtimeAgent,
    authorRole: typeof args.author_role === "string" ? args.author_role : authorDefinition?.role,
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
  const republic_team_init: ToolDefinition = tool({
    description:
      "Initialize a persistent Republic team for the current Git repository. Seats can be auto-allocated from the goal/files, generated from user-provided counts, or taken from explicit config.",
    args: {
      goal: tool.schema.string().describe("Project or task goal used to allocate seats"),
      files: tool.schema.array(tool.schema.string()).optional().describe("Optional relevant files or paths"),
      deliberation_id: tool.schema.string().optional().describe("Optional deliberation ID for the team phase"),
      team_model: tool.schema.enum(TEAM_MODELS).optional().describe("single, advisory, parliament, squad, or parliament_squad"),
      seat_allocation: tool.schema.enum(SEAT_ALLOCATIONS).optional().describe("auto, count, or explicit"),
      planner_seat_count: tool.schema.number().optional().describe("Optional planner seat count"),
      executor_seat_count: tool.schema.number().optional().describe("Optional executor seat count"),
      reviewer_seat_count: tool.schema.number().optional().describe("Optional reviewer seat count"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
      if (!repository) {
        return JSON.stringify({ ok: false, error: "not_git_repository" })
      }

      const goal = String(args.goal ?? "").trim()
      if (!goal) {
        return JSON.stringify({ ok: false, error: "empty_goal" })
      }

      const config = options.config ?? RepublicConfigSchema.parse({})
      const deliberationID = getDeliberationID({ deliberation_id: args.deliberation_id as string | undefined }, context as ToolContextLike)
      const manifest = allocateRepublicTeam({
        goal,
        files: safeStringArray(args.files),
        config,
        teamModel: typeof args.team_model === "string" ? args.team_model : undefined,
        seatAllocation: typeof args.seat_allocation === "string" ? args.seat_allocation as "auto" | "count" | "explicit" : undefined,
        plannerSeatCount: typeof args.planner_seat_count === "number" ? args.planner_seat_count : undefined,
        executorSeatCount: typeof args.executor_seat_count === "number" ? args.executor_seat_count : undefined,
        reviewerSeatCount: typeof args.reviewer_seat_count === "number" ? args.reviewer_seat_count : undefined,
      })

      initializeRepublicTeam(repository, {
        manifest,
        phase: {
          phase: manifest.teamModel === "squad" ? "execution" : "planning",
          status: "planned",
          deliberationID,
          activeRound: 0,
          lockedContracts: [],
          blockedBy: [],
        },
      })

      const summary = `Republic team initialized for "${goal}" with ${manifest.seats.length} seat(s) using ${manifest.seatAllocation} allocation and ${manifest.teamModel} model.`
      appendRepublicCommonsMessage(repository, {
        deliberationID,
        channel: "team",
        phase: "team-init",
        authorSeatID: "republic-orchestrator",
        authorAgent: "republic-orchestrator",
        authorRole: "orchestrator",
        status: "planned",
        messageType: "status",
        content: summary,
      })
      appendRepublicLedgerRecord(repository, {
        deliberationID,
        phase: "team-init",
        chamber: "orchestrator",
        seatID: "republic-orchestrator",
        role: "orchestrator",
        agent: "republic-orchestrator",
        sessionID: (context as ToolContextLike).sessionID,
        status: "planned",
        summary,
      })

      const dashboard = maybeOpenRepublicDashboard({
        repository,
        config,
        event: "team_init",
        deliberationID,
        opener: options.dashboardOpener,
      })

      return JSON.stringify({
        ok: true,
        deliberation_id: deliberationID,
        team_model: manifest.teamModel,
        seat_allocation: manifest.seatAllocation,
        dashboard,
        seats: manifest.seats.map((seat) => ({
          seat_id: seat.seatID,
          role: seat.role,
          phase: seat.phase,
          workgroup_id: seat.workgroupID,
          module: seat.module,
          runtime_agent: seat.runtimeAgent,
          conceptual_agent: seat.conceptualAgent,
          reason: seat.reason,
        })),
      })
    },
  })

  const republic_team_status: ToolDefinition = tool({
    description:
      "Read the persistent Republic team manifest, phase, seat states, optional seat memory, and recent Commons activity for supervisor review or a visual dashboard.",
    args: {
      seat_id: tool.schema.string().optional().describe("Optional seat to filter"),
      deliberation_id: tool.schema.string().optional().describe("Optional deliberation filter for recent Commons messages"),
      include_memory: tool.schema.boolean().optional().describe("Include each selected seat's memory tail"),
      memory_chars: tool.schema.number().optional().describe("Maximum memory characters per seat, default 2000"),
      limit: tool.schema.number().optional().describe("Recent Commons message count, default 10"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
      if (!repository) {
        return JSON.stringify({ ok: false, error: "not_git_repository" })
      }

      const manifest = readRepublicTeamManifest(repository)
      if (!manifest) {
        return JSON.stringify({ ok: false, error: "team_not_initialized" })
      }

      const phase = readRepublicTeamPhase(repository)
      const seatFilter = typeof args.seat_id === "string" && args.seat_id.trim()
        ? sanitizeRepublicDeliberationID(args.seat_id)
        : undefined
      const memoryChars = boundedNumber(args.memory_chars, 2_000, 100, 20_000)
      const limit = boundedNumber(args.limit, 10, 0, 100)
      const deliberationID = typeof args.deliberation_id === "string"
        ? args.deliberation_id
        : phase?.deliberationID
      const selectedSeats = manifest.seats.filter((seat) => !seatFilter || seat.seatID === seatFilter)
      const recentMessages = limit > 0
        ? readRepublicCommonsMessages(repository, deliberationID).slice(-limit)
        : []
      const lockedContracts = readLockedContractContexts(
        repository,
        phase?.lockedContracts,
        args.include_memory === true ? memoryChars : 0,
      )

      return JSON.stringify({
        ok: true,
        team: {
          team_model: manifest.teamModel,
          seat_allocation: manifest.seatAllocation,
          max_parallel_seats: manifest.maxParallelSeats,
          default_runtime_agent: manifest.defaultRuntimeAgent,
        },
        phase,
        locked_contracts: lockedContracts.map((contract) => ({
          id: contract.id,
          path: contract.path,
          found: contract.found,
          ...(contract.content ? { content: contract.content } : {}),
        })),
        seats: selectedSeats.map((seat) => {
          const state = readRepublicSeatState(repository, seat.seatID)
          return {
            ...seat,
            state,
            ...(args.include_memory === true
              ? { memory: tailText(readRepublicSeatMemory(repository, seat.seatID), memoryChars) }
              : {}),
          }
        }),
        recent_messages: recentMessages.map((message) => ({
          message_id: message.messageID,
          message_type: message.messageType,
          author_seat_id: message.authorSeatID,
          target_seat_id: message.targetSeatID,
          phase: message.phase,
          channel: message.channel,
          status: message.status,
          references: message.references,
          content: message.content,
        })),
      })
    },
  })

  const republic_seat_update: ToolDefinition = tool({
    description:
      "Update the current Republic seat's persistent status and memory. Use this when a seat starts work, waits on another seat, becomes blocked, completes a task, or records a durable handoff note.",
    args: {
      seat_id: tool.schema.string().optional().describe("Seat to update; defaults from current agent/session"),
      status: tool.schema.enum(SEAT_STATUSES).optional().describe("standby, running, waiting, blocked, done, or error"),
      phase: tool.schema.enum(TEAM_PHASES).optional().describe("planning, execution, review, or idle"),
      workgroup_id: tool.schema.string().optional().describe("Current workgroup"),
      module: tool.schema.string().optional().describe("Current module or subsystem"),
      task_id: tool.schema.string().optional().describe("Current task ID"),
      waiting_on: tool.schema.array(tool.schema.string()).optional().describe("Message IDs, seat IDs, or workgroups this seat is waiting on"),
      last_message_id: tool.schema.string().optional().describe("Most recent Commons message ID handled by this seat"),
      memory: tool.schema.string().optional().describe("Durable memory note appended to this seat"),
      deliberation_id: tool.schema.string().optional().describe("Deliberation ID for audit messages"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
      if (!repository) {
        return JSON.stringify({ ok: false, error: "not_git_repository" })
      }

      const manifest = readRepublicTeamManifest(repository)
      const seatID = getSeatID({ author_seat_id: args.seat_id as string | undefined }, context as ToolContextLike, repository)
      const existing = readRepublicSeatState(repository, seatID)
      const definition = manifest?.seats.find((seat) => seat.seatID === seatID)
      const status = typeof args.status === "string" ? args.status as typeof SEAT_STATUSES[number] : existing?.status ?? "running"
      const phase = typeof args.phase === "string" ? args.phase as typeof TEAM_PHASES[number] : existing?.phase ?? definition?.phase
      const workgroupID = typeof args.workgroup_id === "string" ? args.workgroup_id : existing?.workgroupID ?? definition?.workgroupID
      const module = typeof args.module === "string" ? args.module : existing?.module ?? definition?.module
      const taskID = typeof args.task_id === "string" ? args.task_id : existing?.taskID ?? definition?.taskID
      const explicitWaitingOn = safeStringArray(args.waiting_on)
      const waitingOn = explicitWaitingOn ?? (status === "waiting" || status === "blocked" ? existing?.waitingOn : [])
      const lastMessageID = typeof args.last_message_id === "string" ? args.last_message_id : existing?.lastMessageID

      writeRepublicSeatState(repository, {
        seatID,
        role: existing?.role ?? definition?.role,
        runtimeAgent: existing?.runtimeAgent ?? definition?.runtimeAgent,
        conceptualAgent: existing?.conceptualAgent ?? definition?.conceptualAgent,
        status,
        phase,
        workgroupID,
        module,
        taskID,
        waitingOn,
        lastMessageID,
        sessionID: (context as ToolContextLike).sessionID ?? existing?.sessionID,
        lastSeenCommonsOffset: existing?.lastSeenCommonsOffset,
      })

      const memory = typeof args.memory === "string" ? args.memory.trim() : ""
      if (memory) {
        appendRepublicSeatMemory(repository, seatID, memory)
      }

      const deliberationID = getDeliberationID({ deliberation_id: args.deliberation_id as string | undefined }, context as ToolContextLike)
      const summaryParts = [
        `Seat ${seatID} is ${status}.`,
        phase ? `phase=${phase}` : undefined,
        workgroupID ? `workgroup=${workgroupID}` : undefined,
        module ? `module=${module}` : undefined,
        taskID ? `task=${taskID}` : undefined,
        waitingOn?.length ? `waiting_on=${waitingOn.join(",")}` : undefined,
      ].filter((part): part is string => typeof part === "string")
      const summary = summaryParts.join(" ")
      appendRepublicCommonsMessage(repository, {
        deliberationID,
        channel: "team",
        phase: "seat-update",
        authorSeatID: seatID,
        authorAgent: existing?.runtimeAgent ?? definition?.runtimeAgent,
        authorRole: existing?.role ?? definition?.role,
        workgroupID,
        module,
        taskID,
        status,
        messageType: "status",
        references: lastMessageID ? [lastMessageID] : undefined,
        content: memory ? `${summary}\n\n${memory}` : summary,
      })
      appendRepublicLedgerRecord(repository, {
        deliberationID,
        phase: "seat-update",
        chamber: "team",
        seatID,
        role: existing?.role ?? definition?.role,
        agent: existing?.runtimeAgent ?? definition?.runtimeAgent,
        sessionID: (context as ToolContextLike).sessionID,
        workgroupID,
        module,
        taskID,
        status,
        summary: memory ? `${summary} ${memory}` : summary,
      })

      return JSON.stringify({
        ok: true,
        seat_id: seatID,
        status,
        phase,
        workgroup_id: workgroupID,
        module,
        task_id: taskID,
        waiting_on: waitingOn,
        last_message_id: lastMessageID,
      })
    },
  })

  const republic_phase_update: ToolDefinition = tool({
    description:
      "Update the persistent Republic team phase. Use this to move from planning to execution, enter review, mark the team blocked/done, or lock contracts that execution seats must follow.",
    args: {
      phase: tool.schema.enum(TEAM_PHASES).describe("planning, execution, review, or idle"),
      status: tool.schema.enum(TEAM_STATUSES).optional().describe("planned, in-progress, blocked, review, or done"),
      deliberation_id: tool.schema.string().optional().describe("Deliberation ID associated with the phase"),
      active_round: tool.schema.number().optional().describe("Current planning/execution/review round"),
      locked_contracts: tool.schema.array(tool.schema.string()).optional().describe("Contract IDs or paths locked for this phase"),
      blocked_by: tool.schema.array(tool.schema.string()).optional().describe("Blocking message IDs, seats, workgroups, or contracts"),
      author_seat_id: tool.schema.string().optional().describe("Seat updating the phase; defaults from current agent/session"),
      reason: tool.schema.string().optional().describe("Short reason for the phase change"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
      if (!repository) {
        return JSON.stringify({ ok: false, error: "not_git_repository" })
      }

      const existing = readRepublicTeamPhase(repository)
      const phase = args.phase as typeof TEAM_PHASES[number]
      const status = typeof args.status === "string"
        ? args.status as typeof TEAM_STATUSES[number]
        : existing?.status ?? "in-progress"
      const deliberationID = getDeliberationID({ deliberation_id: args.deliberation_id as string | undefined }, context as ToolContextLike)
      const activeRound = typeof args.active_round === "number" && Number.isFinite(args.active_round)
        ? Math.max(0, Math.floor(args.active_round))
        : existing?.activeRound
      const lockedContracts = safeStringArray(args.locked_contracts) ?? existing?.lockedContracts ?? []
      const blockedBy = safeStringArray(args.blocked_by) ?? existing?.blockedBy ?? []
      const authorSeatID = getSeatID({ author_seat_id: args.author_seat_id as string | undefined }, context as ToolContextLike, repository)
      const manifest = readRepublicTeamManifest(repository)
      const authorDefinition = manifest?.seats.find((seat) => seat.seatID === authorSeatID)
      const authorRole = authorDefinition?.role ?? "orchestrator"
      const reason = typeof args.reason === "string" ? args.reason.trim() : ""

      writeRepublicTeamPhase(repository, {
        phase,
        status,
        deliberationID,
        activeRound,
        lockedContracts,
        blockedBy,
      })

      const summaryParts = [
        `Republic phase changed to ${phase}/${status}.`,
        activeRound !== undefined ? `round=${activeRound}` : undefined,
        lockedContracts.length ? `locked_contracts=${lockedContracts.join(",")}` : undefined,
        blockedBy.length ? `blocked_by=${blockedBy.join(",")}` : undefined,
      ].filter((part): part is string => typeof part === "string")
      const summary = reason ? `${summaryParts.join(" ")}\n\n${reason}` : summaryParts.join(" ")
      appendRepublicCommonsMessage(repository, {
        deliberationID,
        channel: "team",
        phase: "phase-update",
        authorSeatID,
        authorAgent: authorDefinition?.runtimeAgent,
        authorRole,
        status,
        messageType: "status",
        content: summary,
      })
      appendRepublicLedgerRecord(repository, {
        deliberationID,
        phase: "phase-update",
        chamber: "team",
        seatID: authorSeatID,
        role: authorRole,
        agent: authorDefinition?.runtimeAgent,
        sessionID: (context as ToolContextLike).sessionID,
        status,
        summary,
      })

      return JSON.stringify({
        ok: true,
        phase,
        status,
        deliberation_id: deliberationID,
        active_round: activeRound,
        locked_contracts: lockedContracts,
        blocked_by: blockedBy,
      })
    },
  })

  const republic_round_start: ToolDefinition = tool({
    description:
      "Start an active Republic collaboration round by launching multiple persistent seats as background sessions for planning, execution, review, or idle coordination.",
    args: {
      goal: tool.schema.string().describe("Round objective or task brief"),
      phase: tool.schema.enum(TEAM_PHASES).optional().describe("planning, execution, review, or idle; defaults from current team phase"),
      deliberation_id: tool.schema.string().optional().describe("Deliberation ID; defaults from current team phase or session"),
      seat_ids: tool.schema.array(tool.schema.string()).optional().describe("Optional explicit seats to launch"),
      workgroup_id: tool.schema.string().optional().describe("Optional workgroup filter"),
      include_supervisor: tool.schema.boolean().optional().describe("Whether to include supervisor seats"),
      max_seats: tool.schema.number().optional().describe("Maximum seats to launch"),
      round: tool.schema.number().optional().describe("Round number"),
      dry_run: tool.schema.boolean().optional().describe("Return selected seats without launching"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
      if (!repository) {
        return JSON.stringify({ ok: false, error: "not_git_repository" })
      }
      if (!options.manager && args.dry_run !== true) {
        return JSON.stringify({ ok: false, error: "scheduler_unavailable" })
      }
      const sessionID = (context as ToolContextLike).sessionID
      if (!sessionID && args.dry_run !== true) {
        return JSON.stringify({ ok: false, error: "missing_session" })
      }

      const manifest = readRepublicTeamManifest(repository)
      if (!manifest) {
        return JSON.stringify({ ok: false, error: "team_not_initialized" })
      }
      const phaseState = readRepublicTeamPhase(repository)
      const phase = typeof args.phase === "string"
        ? args.phase as typeof TEAM_PHASES[number]
        : phaseState?.phase ?? "planning"
      const goal = String(args.goal ?? "").trim()
      if (!goal) {
        return JSON.stringify({ ok: false, error: "empty_goal" })
      }
      const deliberationID = typeof args.deliberation_id === "string"
        ? sanitizeRepublicDeliberationID(args.deliberation_id)
        : phaseState?.deliberationID ?? getDeliberationID({}, context as ToolContextLike)
      const round = typeof args.round === "number" && Number.isFinite(args.round)
        ? Math.max(0, Math.floor(args.round))
        : (phaseState?.activeRound ?? 0) + 1
      const maxSeats = boundedNumber(args.max_seats, manifest.maxParallelSeats, 1, manifest.maxParallelSeats)
      const selectedSeats = selectRoundSeats({
        seats: manifest.seats,
        phase,
        explicitSeatIDs: safeStringArray(args.seat_ids),
        workgroupID: typeof args.workgroup_id === "string" ? args.workgroup_id : undefined,
        includeSupervisor: args.include_supervisor === true,
        maxSeats,
      })

      if (args.dry_run === true) {
        return JSON.stringify({
          ok: true,
          dry_run: true,
          deliberation_id: deliberationID,
          phase,
          round,
          seats: selectedSeats.map((seat) => seat.seatID),
        })
      }

      writeRepublicTeamPhase(repository, {
        phase,
        status: "in-progress",
        deliberationID,
        activeRound: round,
        lockedContracts: phaseState?.lockedContracts ?? [],
        blockedBy: phaseState?.blockedBy ?? [],
      })

      const dispatches = []
      const lockedContractContext = readLockedContractContexts(
        repository,
        phaseState?.lockedContracts,
        4_000,
      )
      for (const seat of selectedSeats) {
        const requestedAgent = resolveDispatchAgent(seat.seatID, {
          target_agent: seat.runtimeAgent,
        }, options.config)
        const dispatchAgent = await resolveRuntimeDispatchAgent({ ctx, requestedAgent, config: options.config })
        writeRepublicSeatState(repository, {
          seatID: seat.seatID,
          role: seat.role,
          runtimeAgent: dispatchAgent.runtimeAgent,
          conceptualAgent: dispatchAgent.requestedAgent,
          status: "running",
          phase,
          workgroupID: seat.workgroupID,
          module: seat.module,
          taskID: seat.taskID,
          sessionID,
        })
        appendRepublicSeatMemory(repository, seat.seatID, `Round ${round} dispatched for ${phase}: ${goal}`)

        const prompt = buildRoundPrompt({
          seat,
          phase,
          deliberationID,
          goal,
          round,
          lockedContracts: phaseState?.lockedContracts ?? [],
          blockedBy: phaseState?.blockedBy ?? [],
          lockedContractContext,
          requestedAgent: dispatchAgent.requestedAgent,
          runtimeAgent: dispatchAgent.runtimeAgent,
          labeledContext: options.config?.weak_model_guardrails?.labeled_context ?? true,
        })
        const task = await options.manager!.launch({
          description: `Republic ${phase} round ${round}: ${seat.seatID}`,
          prompt,
          agent: dispatchAgent.runtimeAgent,
          parentSessionId: sessionID!,
          parentMessageId: (context as ToolContextLike).messageID ?? "",
          parentAgent: (context as ToolContextLike).agent,
          category: `republic-${phase}-round`,
        })

        const agentSummary = dispatchAgent.runtimeAgent === dispatchAgent.requestedAgent
          ? dispatchAgent.runtimeAgent
          : `${dispatchAgent.runtimeAgent} (requested ${dispatchAgent.requestedAgent})`
        const summary = `Republic scheduler launched ${seat.seatID} for ${phase} round ${round} via ${agentSummary} as background task ${task.id}.`
        appendRepublicCommonsMessage(repository, {
          deliberationID,
          channel: "scheduler",
          phase: "round-dispatch",
          round,
          authorSeatID: "republic-scheduler",
          authorAgent: "republic-scheduler",
          authorRole: "scheduler",
          targetSeatID: seat.seatID,
          workgroupID: seat.workgroupID,
          module: seat.module,
          taskID: task.id,
          status: "dispatched",
          messageType: "status",
          content: summary,
        })
        appendRepublicLedgerRecord(repository, {
          deliberationID,
          phase: "round-dispatch",
          chamber: "scheduler",
          seatID: "republic-scheduler",
          role: "scheduler",
          agent: "republic-scheduler",
          sessionID,
          workgroupID: seat.workgroupID,
          module: seat.module,
          taskID: task.id,
          status: "dispatched",
          summary,
        })
        dispatches.push({
          seat_id: seat.seatID,
          task_id: task.id,
          agent: dispatchAgent.runtimeAgent,
          ...(dispatchAgent.runtimeAgent !== dispatchAgent.requestedAgent
            ? { requested_agent: dispatchAgent.requestedAgent }
            : {}),
        })
      }

      const dashboard = maybeOpenRepublicDashboard({
        repository,
        config: options.config,
        event: "round_start",
        deliberationID,
        opener: options.dashboardOpener,
      })

      return JSON.stringify({
        ok: true,
        deliberation_id: deliberationID,
        phase,
        round,
        dashboard,
        dispatches,
      })
    },
  })

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

      const message = buildCommonsMessage(args, context as ToolContextLike, args.message_type as RepublicCommonsMessage["messageType"], repository)
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
      let queuedDispatch: QueuedDispatchResult | null = null
      let queuedSupervisorDispatch: QueuedDispatchResult | null = null
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
      if (!dispatch) {
        queuedDispatch = queueRepublicSeatDispatch({
          repository,
          message,
          toolArgs: args,
          config: options.config,
          reason: options.manager ? "missing_parent_session_or_dispatch_unavailable" : "manager_unavailable",
        })
      }
      if (!supervisorDispatch) {
        queuedSupervisorDispatch = queueRepublicSupervisorDispatch({
          repository,
          message,
          config: options.config,
          reason: options.manager ? "missing_parent_session_or_dispatch_unavailable" : "manager_unavailable",
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
        ...(queuedDispatch ? { queued_dispatch: queuedDispatch } : {}),
        ...(queuedSupervisorDispatch ? { queued_supervisor_dispatch: queuedSupervisorDispatch } : {}),
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

      const seatID = getSeatID({ author_seat_id: args.seat_id as string | undefined }, context as ToolContextLike, repository)
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
        const phase = readRepublicTeamPhase(repository)
        const manifest = readRepublicTeamManifest(repository)
        const teamSeat = manifest?.seats.find((seat) => seat.seatID === seatID)
        if (phase) {
          parts.push("", "## Current Phase", [
            `- phase: ${phase.phase}`,
            `- status: ${phase.status}`,
            phase.deliberationID ? `- deliberation: ${phase.deliberationID}` : undefined,
            phase.activeRound !== undefined ? `- active_round: ${phase.activeRound}` : undefined,
            phase.lockedContracts?.length ? `- locked_contracts: ${phase.lockedContracts.join(", ")}` : undefined,
            phase.blockedBy?.length ? `- blocked_by: ${phase.blockedBy.join(", ")}` : undefined,
          ].filter((line): line is string => typeof line === "string").join("\n"))
          const lockedContracts = readLockedContractContexts(repository, phase.lockedContracts, 2_000)
          if (lockedContracts.length > 0) {
            parts.push("", "## Locked Contracts", lockedContracts.map((contract) => [
              `### ${contract.id}`,
              `path: ${contract.path}`,
              contract.found && contract.content ? contract.content.trim() : "missing: contract file was not found at this path",
            ].join("\n")).join("\n\n"))
          }
        }
        if (teamSeat) {
          const seatLines = [
            `- role: ${teamSeat.role}`,
            teamSeat.phase ? `- phase: ${teamSeat.phase}` : undefined,
            teamSeat.workgroupID ? `- workgroup: ${teamSeat.workgroupID}` : undefined,
            teamSeat.module ? `- module: ${teamSeat.module}` : undefined,
            teamSeat.reason ? `- reason: ${teamSeat.reason}` : undefined,
          ].filter((line): line is string => typeof line === "string")
          parts.push("", "## Team Seat", seatLines.join("\n"))
          parts.push("", "## Operating Checklist", buildConstrainedOperatingRules({
            phase: phase?.phase ?? teamSeat.phase ?? "idle",
            seat: teamSeat,
            labeledContext: options.config?.weak_model_guardrails?.labeled_context ?? true,
          }).join("\n"))
        }
      }
      return parts.join("\n")
    },
  })

  const republic_wait: ToolDefinition = tool({
    description:
      "Wait for Republic Commons responses that reference an earlier message. Use this after publishing a targeted question, handoff, or objection when the current seat should block until another seat or supervisor replies.",
    args: {
      message_id: tool.schema.string().describe("Original Commons message ID to wait on"),
      deliberation_id: tool.schema.string().optional().describe("Optional deliberation filter"),
      message_types: tool.schema.array(tool.schema.string()).optional().describe("Response message types to accept; defaults to answer, revision, objection, consensus, contract, handoff"),
      timeout_ms: tool.schema.number().optional().describe("Maximum wait in milliseconds, default 30000"),
      poll_interval_ms: tool.schema.number().optional().describe("Polling interval in milliseconds, default 1000"),
    },
    execute: async (args, context) => {
      const repository = getToolRepository(ctx, context as ToolContextLike)
      if (!repository) {
        return JSON.stringify({ ok: false, error: "not_git_repository" })
      }

      const messageID = String(args.message_id ?? "").trim()
      if (!messageID) {
        return JSON.stringify({ ok: false, error: "missing_message_id" })
      }

      const deliberationID = typeof args.deliberation_id === "string" ? args.deliberation_id : undefined
      const messageTypes = new Set(safeStringArray(args.message_types) ?? DEFAULT_WAIT_MESSAGE_TYPES)
      const timeoutMs = boundedNumber(args.timeout_ms, 30_000, 100, 300_000)
      const pollIntervalMs = boundedNumber(args.poll_interval_ms, 1_000, 25, 10_000)
      const startedAt = Date.now()

      while (Date.now() - startedAt <= timeoutMs) {
        const responses = findReferencedResponses({
          repository,
          messageID,
          deliberationID,
          messageTypes,
        })
        if (responses.length > 0) {
          return JSON.stringify({
            ok: true,
            message_id: messageID,
            responses: responses.map((message) => ({
              message_id: message.messageID,
              message_type: message.messageType,
              author_seat_id: message.authorSeatID,
              target_seat_id: message.targetSeatID,
              status: message.status,
              references: message.references,
              content: message.content,
            })),
          })
        }

        await sleep(pollIntervalMs)
      }

      return JSON.stringify({
        ok: false,
        timeout: true,
        message_id: messageID,
        waited_ms: Date.now() - startedAt,
      })
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

      const authorSeatID = getSeatID({ author_seat_id: args.author_seat_id as string | undefined }, context as ToolContextLike, repository)
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
        repository,
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
    republic_team_init,
    republic_team_status,
    republic_seat_update,
    republic_phase_update,
    republic_round_start,
    republic_publish,
    republic_inbox,
    republic_wait,
    republic_contract,
  }
}
