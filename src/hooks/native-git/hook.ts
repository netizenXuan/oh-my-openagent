import type { PluginInput } from "@opencode-ai/plugin"
import { existsSync, readFileSync } from "node:fs"
import type { NativeGitConfig, RepublicConfig } from "../../config"
import {
  appendNativeGitAuditRecord,
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  getRepublicContractPath,
  getNativeGitChangeSummary,
  getNativeGitStatus,
  readRepublicCommonsMessages,
  readRepublicInboxMessages,
  readRepublicSeatMemory,
  readRepublicSeatState,
  readRepublicTeamManifest,
  readRepublicTeamPhase,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
  type RepublicCommonsMessage,
} from "../../shared/git-worktree"
import { log } from "../../shared/logger"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"

const TRACKED_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "hashline_edit", "bash", "task"])

type NativeGitToolInput = {
  tool: string
  sessionID?: string
  callID?: string
  agent?: string
  model?: string
  category?: string
}

type NativeGitChatInput = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
  category?: string
  promptText?: string
}

type NativeGitChatOutput = {
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>
}

type NativeGitSessionContext = {
  agent?: string
  model?: string
  category?: string
  requestedPaths?: string[]
}

type NativeGitEventInput = {
  event: {
    type: string
    properties?: unknown
  }
}

type NativeGitTrackResult = {
  dirty: boolean
  changedSinceLastCheck: boolean
  summary?: string
  supervisorMessage?: string
  dependencyGateMessage?: string
}

type NativeGitDirtyState = {
  fileCount: number
}

type NativeGitCallBaseline = {
  repositoryRoot: string
  statusKey: string
}

export const NATIVE_GIT_TASK_REMINDER = `
<system-reminder>
Native Git tracking detected uncommitted changes. Before final completion, use git-master to create atomic commits, for example:
task(category="quick", load_skills=["git-master"], prompt="Commit the current changes atomically following git-master conventions.")
</system-reminder>`

const NATIVE_GIT_TOAST_TITLE = "Native Git changes tracked"
const NATIVE_GIT_TOAST_MESSAGE =
  "Uncommitted changes are being audited. Before final completion, use git-master to create atomic commits."

function appendOutput(output: { output?: string }, text: string): void {
  output.output = `${output.output ?? ""}${text}`
}

function buildTrackingMessage(summary: string): string {
  return `
<system-reminder>
Native Git tracking detected uncommitted changes.

${summary.trim()}
</system-reminder>`
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "")
}

function getFileModule(filePath: string): string {
  const normalized = normalizePath(filePath)
  const parts = normalized.split("/").filter(Boolean)
  if (parts.length === 0) {
    return "workspace"
  }

  if (parts[0] === ".sisyphus") {
    return parts[1] ? `.sisyphus/${parts[1]}` : ".sisyphus"
  }

  if (parts[0] === ".github") {
    return parts[1] ? `.github/${parts[1]}` : ".github"
  }

  if (parts[0] === "src" && parts[1] && parts.length > 2) {
    return `src/${parts[1]}`
  }

  if (parts[0] === "docs" && parts[1] && parts.length > 2) {
    return `docs/${parts[1]}`
  }

  return parts[0] ?? "workspace"
}

function getModules(files: string[]): string[] {
  return Array.from(new Set(files.map(getFileModule))).sort()
}

function getPrimaryModule(files: string[]): string {
  return getModules(files)[0] ?? "workspace"
}

function getWorkgroupID(moduleName: string): string {
  return `wg-${sanitizeRepublicDeliberationID(moduleName).toLowerCase()}`
}

function getDeliberationID(input: NativeGitToolInput): string {
  return sanitizeRepublicDeliberationID(`session-${input.sessionID ?? "unknown"}`)
}

function getSeatID(input: NativeGitToolInput): string {
  return sanitizeRepublicDeliberationID(`${input.agent ?? "agent"}-executor`)
}

function getTaskID(input: NativeGitToolInput, moduleName: string): string {
  const callFragment = input.callID ? input.callID.slice(0, 12) : "tool"
  return sanitizeRepublicDeliberationID(`${input.agent ?? "agent"}-${input.tool}-${moduleName}-${callFragment}`)
}

function isRepublicLedgerEnabled(config: RepublicConfig | undefined): boolean {
  return (config?.enabled ?? true) && (config?.ledger ?? true) && (config?.mode ?? "advisory") !== "manual"
}

function isRepublicAutoCommonsEnabled(config: RepublicConfig | undefined): boolean {
  return isRepublicLedgerEnabled(config) && (config?.commons?.auto_publish ?? true)
}

function appendBeforeMessage(output: { message?: string }, text: string): void {
  output.message = `${output.message ?? ""}${text}`
}

function buildSupervisorInterventionMessage(message: string): string {
  return `
<system-reminder>
Republic supervisor intervention recorded.

${message.trim()}
</system-reminder>`
}

function buildPostChangeDependencyGateMessage(message: string): string {
  const status = message.includes("Dependency gate blocked") ? "blocked" : "recorded"
  return `
<system-reminder>
Republic workgroup dependency gate ${status}.

${message.trim()}
</system-reminder>`
}

function buildDependencyGateMessage(modules: string[], files: string[]): string {
  return `
<system-reminder>
Republic workgroup dependency gate: this tool call touches ${modules.length} inferred workgroups (${modules.join(", ")}).
Record a Commons note or split the work before continuing if these modules depend on each other.

Files:
${files.map((file) => `- ${file}`).join("\n")}
</system-reminder>`
}

function getStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value]
  }
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
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

function formatConstrainedOperatingChecklist(args: {
  phase?: string
  workgroupID?: string
  module?: string
}): string[] {
  const scope = [
    args.workgroupID ? `workgroup=${args.workgroupID}` : undefined,
    args.module ? `module=${args.module}` : undefined,
  ].filter((part): part is string => typeof part === "string")
  const execution = args.phase === "execution"
  return [
    "operating_checklist:",
    scope.length ? `- Treat this seat scope as authoritative: ${scope.join(", ")}.` : "- Treat the current seat scope as authoritative.",
    "- Work in one bounded step at a time; if the next step is unclear, publish a targeted question before editing.",
    "- Do not invent substitute field names, status values, file paths, or environment variables when the objective or contracts already name them.",
    "- Do not create or update dependencies, lockfiles, generated scripts, global config, or helper files unless the objective or a locked contract explicitly names them.",
    execution
      ? "- Keep execution edits inside this seat's workgroup; if another workgroup is needed, publish a handoff or objection and stop."
      : "- Keep outputs in Republic tools during planning/review; do not modify project files from this phase.",
    execution
      ? "- After execution edits, run the smallest relevant verification named by the objective/contracts and publish the result or blocker."
      : "- Prefer concise proposals, questions, objections, revisions, or contracts that other seats can answer directly.",
  ]
}

function isBashMutationCommand(command: string): boolean {
  return /(?:^|[\s;&|])(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|mkdir|md|ni|rm|cp|mv)(?=\s|$)/i.test(command)
    || /(^|[^>])>{1,2}[^>]/.test(command)
    || /\b(node|python|python3|bun)\b[\s\S]*\b(writeFileSync|writeFile|open\s*\()/i.test(command)
}

function getBashTargetPaths(command: string): string[] {
  if (!isBashMutationCommand(command)) {
    return []
  }

  const paths = new Set<string>()
  const normalizedCommand = command.replace(/\\/g, "/")
  const pathPattern = /(?<![A-Za-z0-9_-])((?:\.sisyphus|\.github|src|docs|test|tests|packages|apps|config|scripts|assets)\/[A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_-]+)?)/g
  let match: RegExpExecArray | null
  while ((match = pathPattern.exec(normalizedCommand)) !== null) {
    const candidate = match[1]?.replace(/[),;]+$/g, "")
    if (candidate) {
      paths.add(normalizePath(candidate))
    }
  }

  return Array.from(paths).sort()
}

function getPromptMentionedPaths(promptText: string | undefined): string[] {
  if (!promptText) {
    return []
  }

  const paths = new Set<string>()
  const normalizedText = promptText.replace(/\\/g, "/")
  const pathPattern = /(?<![A-Za-z0-9_-])((?:\.sisyphus|\.github|\.opencode|src|docs|test|tests|packages|apps|config|scripts|assets)\/[A-Za-z0-9_./-]+|(?:package\.json|bun\.lock|README\.md|tsconfig\.json))/g
  let match: RegExpExecArray | null
  while ((match = pathPattern.exec(normalizedText)) !== null) {
    const candidate = match[1]?.replace(/[`"'),;:]+$/g, "")
    if (candidate) {
      paths.add(normalizePath(candidate))
    }
  }

  return Array.from(paths).slice(0, 50).sort()
}

function getToolTargetPaths(tool: string, args: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  for (const key of ["filePath", "file_path", "path", "file", "movePath", "move_path"]) {
    for (const value of getStringArray(args[key])) {
      paths.add(normalizePath(value))
    }
  }

  const edits = args.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!isRecord(edit)) {
        continue
      }
      for (const key of ["filePath", "file_path", "path", "file", "movePath", "move_path"]) {
        const value = edit[key]
        if (typeof value === "string" && value.length > 0) {
          paths.add(normalizePath(value))
        }
      }
    }
  }

  if (tool.toLowerCase() === "apply_patch") {
    const patch = typeof args.patch === "string" ? args.patch : typeof args.content === "string" ? args.content : ""
    for (const line of patch.split(/\r?\n/)) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) ?? line.match(/^\*\*\* Move to: (.+)$/)
      if (match?.[1]) {
        paths.add(normalizePath(match[1].trim()))
      }
    }
  }

  if (tool.toLowerCase() === "bash" && typeof args.command === "string") {
    for (const filePath of getBashTargetPaths(args.command)) {
      paths.add(filePath)
    }
  }

  return Array.from(paths).sort()
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizePath(filePath)
  const normalizedPattern = normalizePath(pattern)
  if (normalizedPattern.endsWith("/")) {
    return normalizedFile.startsWith(normalizedPattern)
  }
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getStringProperty(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) {
      return value
    }
  }
  return undefined
}

function getCallKey(input: NativeGitToolInput): string | null {
  if (!input.callID) {
    return null
  }

  return `${input.sessionID ?? "unknown"}:${input.callID}`
}

function getStateKey(sessionID: string, repoRoot: string): string {
  return `${sessionID}:${repoRoot}`
}

function normalizeAgent(agent: string | undefined): string | undefined {
  return agent ? getAgentConfigKey(agent) : undefined
}

function formatModelID(model: NativeGitChatInput["model"]): string | undefined {
  if (!model) {
    return undefined
  }

  if (model.modelID.includes("/")) {
    return model.modelID
  }

  return `${model.providerID}/${model.modelID}`
}

function deleteSessionMapEntries<T>(map: Map<string, T>, sessionID: string): void {
  const prefix = `${sessionID}:`
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) {
      map.delete(key)
    }
  }
}

function getNativeGitToolInputFromEvent(input: NativeGitEventInput): NativeGitToolInput | null {
  if (!isRecord(input.event.properties)) {
    return null
  }

  if (input.event.type === "tool.execute" || input.event.type === "tool.result") {
    const tool = getStringProperty(input.event.properties, ["name", "tool"])
    if (!tool) {
      return null
    }

    return {
      tool,
      sessionID: getStringProperty(input.event.properties, ["sessionID", "sessionId"]),
      callID: getStringProperty(input.event.properties, ["callID", "callId", "call_id"]),
      agent: getStringProperty(input.event.properties, ["agent", "agentID", "agentId"]),
      model: getStringProperty(input.event.properties, ["model", "modelID", "modelId"]),
      category: getStringProperty(input.event.properties, ["category"]),
    }
  }

  if (input.event.type !== "message.part.updated") {
    return null
  }

  const part = input.event.properties.part
  if (!isRecord(part) || getStringProperty(part, ["type"]) !== "tool") {
    return null
  }

  const state = isRecord(part.state) ? part.state : undefined
  const status = state ? getStringProperty(state, ["status"]) : undefined
  if (status !== "completed") {
    return null
  }

  const tool = getStringProperty(part, ["tool", "name"])
  if (!tool) {
    return null
  }

  return {
    tool,
    sessionID:
      getStringProperty(part, ["sessionID", "sessionId"]) ??
      getStringProperty(input.event.properties, ["sessionID", "sessionId"]),
    callID:
      getStringProperty(part, ["callID", "callId", "call_id"]) ??
      getStringProperty(input.event.properties, ["callID", "callId", "call_id"]),
    agent:
      getStringProperty(part, ["agent", "agentID", "agentId"]) ??
      getStringProperty(input.event.properties, ["agent", "agentID", "agentId"]),
    model:
      getStringProperty(part, ["model", "modelID", "modelId"]) ??
      getStringProperty(input.event.properties, ["model", "modelID", "modelId"]),
    category: getStringProperty(part, ["category"]) ?? getStringProperty(input.event.properties, ["category"]),
  }
}

function mergeToolOutputMetadata(
  input: NativeGitToolInput,
  metadata: Record<string, unknown> | undefined,
): NativeGitToolInput {
  if (!metadata) {
    return input
  }

  return {
    ...input,
    agent: input.agent ?? getStringProperty(metadata, ["agent", "agentID", "agentId"]),
    model: input.model ?? getStringProperty(metadata, ["model", "modelID", "modelId"]),
    category: input.category ?? getStringProperty(metadata, ["category"]),
  }
}

export function createNativeGitHook(
  ctx: PluginInput,
  config: NativeGitConfig | undefined,
  republicConfig?: RepublicConfig,
) {
  const mode = config?.mode ?? "tracked"
  const auditLog = config?.audit_log ?? true
  const lastStatusBySessionRepo = new Map<string, string>()
  const dirtyStateBySession = new Map<string, NativeGitDirtyState>()
  const lastToastStatusBySession = new Map<string, string>()
  const baselineByCall = new Map<string, NativeGitCallBaseline>()
  const changedResultByCall = new Map<string, NativeGitTrackResult>()
  const auditedCallKeys = new Set<string>()
  const republicPublishedCallKeys = new Set<string>()
  const dependencyGatePublishedCallKeys = new Set<string>()
  const supervisorPublishedCallKeys = new Set<string>()
  const outputReminderCallKeys = new Set<string>()
  const dependencyGateReminderCallKeys = new Set<string>()
  const supervisorReminderCallKeys = new Set<string>()
  const taskReminderCallKeys = new Set<string>()
  const initialStatusByRepo = new Map<string, string>()
  const sessionContextBySession = new Map<string, NativeGitSessionContext>()
  const policyLoopStatusBySession = new Map<string, string>()

  const initialStatus = mode === "manual" ? null : getNativeGitStatus(ctx.directory)
  if (initialStatus) {
    initialStatusByRepo.set(initialStatus.repository.repoRoot, initialStatus.dirty ? initialStatus.statusKey : "")
  }

  function clearSessionState(sessionID: string): void {
    dirtyStateBySession.delete(sessionID)
    lastToastStatusBySession.delete(sessionID)
    sessionContextBySession.delete(sessionID)
    policyLoopStatusBySession.delete(sessionID)
    deleteSessionMapEntries(lastStatusBySessionRepo, sessionID)
    deleteSessionMapEntries(baselineByCall, sessionID)
    deleteSessionMapEntries(changedResultByCall, sessionID)

    for (const set of [
      auditedCallKeys,
      republicPublishedCallKeys,
      dependencyGatePublishedCallKeys,
      supervisorPublishedCallKeys,
      outputReminderCallKeys,
      dependencyGateReminderCallKeys,
      supervisorReminderCallKeys,
      taskReminderCallKeys,
    ]) {
      for (const key of set) {
        if (key.startsWith(`${sessionID}:`)) {
          set.delete(key)
        }
      }
    }
  }

  function rememberSessionContext(input: NativeGitChatInput): void {
    const requestedPaths = getPromptMentionedPaths(input.promptText)
    sessionContextBySession.set(input.sessionID, {
      agent: normalizeAgent(input.agent),
      model: formatModelID(input.model),
      category: input.category,
      requestedPaths: requestedPaths.length > 0 ? requestedPaths : undefined,
    })
  }

  function enrichToolInput(input: NativeGitToolInput): NativeGitToolInput {
    const sessionID = input.sessionID ?? "unknown"
    const sessionContext = sessionContextBySession.get(sessionID)
    const sessionAgent = input.sessionID ? getSessionAgent(input.sessionID) : undefined

    return {
      ...input,
      agent: normalizeAgent(input.agent) ?? sessionContext?.agent ?? normalizeAgent(sessionAgent),
      model: input.model ?? sessionContext?.model,
      category: input.category ?? sessionContext?.category,
    }
  }

  function prependChatContext(output: NativeGitChatOutput, text: string): void {
    const textPart = output.parts.find((part) => part.type === "text" && typeof part.text === "string")
    if (!textPart) {
      return
    }
    textPart.text = `${text.trim()}\n\n---\n\n${textPart.text ?? ""}`
  }

  function formatInboxInjection(messages: RepublicCommonsMessage[]): string {
    const lines: Array<string | undefined> = [
      "<republic-commons-inbox>",
      "Relevant Republic Commons messages for this seat. Use republic_publish for answers, objections, revisions, handoffs, or supervisor responses.",
      "",
    ]
    for (const message of messages) {
      lines.push(
        `- id: ${message.messageID ?? "unknown"}`,
        `  type: ${message.messageType}`,
        `  from: ${message.authorSeatID}${message.targetSeatID ? ` -> ${message.targetSeatID}` : ""}`,
        message.workgroupID ? `  workgroup: ${message.workgroupID}` : undefined,
        message.module ? `  module: ${message.module}` : undefined,
        message.taskID ? `  task: ${message.taskID}` : undefined,
        message.files?.length ? `  files: ${message.files.join(", ")}` : undefined,
        `  content: ${message.content.trim().replace(/\s+/g, " ")}`,
        "",
      )
    }
    lines.push("</republic-commons-inbox>")
    return lines.filter((line): line is string => typeof line === "string").join("\n")
  }

  function formatTeamInjection(repository: NativeGitRepository, seatID: string): string | undefined {
    const manifest = readRepublicTeamManifest(repository)
    const phase = readRepublicTeamPhase(repository)
    if (!manifest && !phase) {
      return undefined
    }

    const state = readRepublicSeatState(repository, seatID)
    const definition = manifest?.seats.find((seat) => seat.seatID === seatID)
    const memory = state || definition ? readRepublicSeatMemory(repository, seatID).trim() : ""
    const lockedContractLines = (phase?.lockedContracts ?? []).slice(0, 5).flatMap((contractID) => {
      const normalizedID = normalizeLockedContractID(contractID)
      const contractPath = getRepublicContractPath(repository, normalizedID)
      if (!existsSync(contractPath)) {
        return [`- ${normalizedID}: missing at ${contractPath}`]
      }
      return [
        `- ${normalizedID}: ${contractPath}`,
        tailText(readFileSync(contractPath, "utf-8"), 1200),
      ]
    })
    const roster = manifest?.seats.slice(0, 12).map((seat) => {
      const seatState = readRepublicSeatState(repository, seat.seatID)
      return `- ${seat.seatID}: ${seat.role}${seat.phase ? `/${seat.phase}` : ""}${seat.workgroupID ? ` workgroup=${seat.workgroupID}` : ""}${seat.module ? ` module=${seat.module}` : ""}${seatState?.status ? ` status=${seatState.status}` : ""}`
    }) ?? []

    const lines: Array<string | undefined> = [
      "<republic-team-state>",
      "Persistent Republic team state for this repository. Use republic_seat_update when your status changes, republic_team_status for the full read model, and republic_phase_update when supervisor locks phase transitions.",
      phase ? `phase: ${phase.phase}/${phase.status}${phase.activeRound !== undefined ? ` round=${phase.activeRound}` : ""}` : undefined,
      phase?.lockedContracts?.length ? `locked_contracts: ${phase.lockedContracts.join(", ")}` : undefined,
      phase?.blockedBy?.length ? `blocked_by: ${phase.blockedBy.join(", ")}` : undefined,
      manifest ? `team_model: ${manifest.teamModel}` : undefined,
      manifest ? `seat_allocation: ${manifest.seatAllocation}` : undefined,
      "",
      state || definition ? `current_seat: ${seatID}` : `current_seat: ${seatID} (not in current team manifest)`,
      definition?.role ? `role: ${definition.role}` : state?.role ? `role: ${state.role}` : undefined,
      state?.status ? `status: ${state.status}` : undefined,
      state?.workgroupID || definition?.workgroupID ? `workgroup: ${state?.workgroupID ?? definition?.workgroupID}` : undefined,
      state?.module || definition?.module ? `module: ${state?.module ?? definition?.module}` : undefined,
      state?.taskID || definition?.taskID ? `task: ${state?.taskID ?? definition?.taskID}` : undefined,
      state?.waitingOn?.length ? `waiting_on: ${state.waitingOn.join(", ")}` : undefined,
      "",
      ...formatConstrainedOperatingChecklist({
        phase: phase?.phase ?? definition?.phase ?? state?.phase,
        workgroupID: state?.workgroupID ?? definition?.workgroupID,
        module: state?.module ?? definition?.module,
      }),
      lockedContractLines.length ? "" : undefined,
      lockedContractLines.length ? "locked_contract_excerpts:" : undefined,
      ...lockedContractLines,
      memory ? "" : undefined,
      memory ? "memory_tail:" : undefined,
      memory ? tailText(memory, 1200) : undefined,
      roster.length ? "" : undefined,
      roster.length ? "team_roster:" : undefined,
      ...roster,
      "</republic-team-state>",
    ]

    return lines.filter((line): line is string => typeof line === "string").join("\n")
  }

  function injectRepublicInbox(input: NativeGitChatInput, output: NativeGitChatOutput | undefined): void {
    if (!output || !isRepublicLedgerEnabled(republicConfig) || !(republicConfig?.commons?.inbox ?? true)) {
      return
    }

    const status = getNativeGitStatus(ctx.directory)
    if (!status) {
      return
    }

    const enriched = enrichToolInput({
      tool: "chat",
      sessionID: input.sessionID,
      agent: input.agent,
      model: input.model ? formatModelID(input.model) : undefined,
      category: input.category,
    })
    const seatID = getSeatID(enriched)
    const sessionContext = sessionContextBySession.get(input.sessionID)
    const modules = getModules(sessionContext?.requestedPaths ?? [])
    const moduleName = modules[0]
    const messages = readRepublicInboxMessages(status.repository, {
      seatID,
      deliberationID: getDeliberationID(enriched),
      workgroupID: moduleName ? getWorkgroupID(moduleName) : undefined,
      module: moduleName,
      limit: republicConfig?.commons?.inject_max_messages ?? 6,
    })

    const injections: string[] = []
    const teamInjection = formatTeamInjection(status.repository, seatID)
    if (teamInjection) {
      injections.push(teamInjection)
    }
    if (messages.length > 0) {
      injections.push(formatInboxInjection(messages))
    }

    if (injections.length > 0) {
      prependChatContext(output, injections.join("\n\n"))
    }
  }

  function findUnresolvedQuestions(messages: RepublicCommonsMessage[]): RepublicCommonsMessage[] {
    const answeredReferences = new Set<string>()
    for (const message of messages) {
      if (message.messageType === "answer" || message.messageType === "revision" || message.messageType === "consensus") {
        for (const reference of message.references ?? []) {
          answeredReferences.add(reference)
        }
      }
    }
    return messages.filter((message) => message.messageType === "question" && message.messageID && !answeredReferences.has(message.messageID))
  }

  function findUnresolvedObjections(messages: RepublicCommonsMessage[]): RepublicCommonsMessage[] {
    const resolvedReferences = new Set<string>()
    for (const message of messages) {
      if (message.messageType === "revision" || message.messageType === "consensus") {
        for (const reference of message.references ?? []) {
          resolvedReferences.add(reference)
        }
      }
    }
    return messages.filter((message) => message.messageType === "objection" && message.messageID && !resolvedReferences.has(message.messageID))
  }

  function policyAlreadyCovers(messages: RepublicCommonsMessage[], unresolvedMessages: RepublicCommonsMessage[]): boolean {
    const unresolvedIDs = unresolvedMessages.map((message) => message.messageID).filter((id): id is string => Boolean(id))
    if (unresolvedIDs.length === 0) {
      return true
    }

    const latestUnresolvedTimestamp = unresolvedMessages
      .map((message) => message.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1)

    return messages.some((message) => {
      if (message.messageType !== "supervisor-policy") {
        return false
      }
      if (latestUnresolvedTimestamp && message.timestamp && message.timestamp < latestUnresolvedTimestamp) {
        return false
      }
      const references = new Set(message.references ?? [])
      return unresolvedIDs.every((id) => references.has(id))
    })
  }

  function groupMessagesByDeliberation(messages: RepublicCommonsMessage[]): Map<string, RepublicCommonsMessage[]> {
    const groups = new Map<string, RepublicCommonsMessage[]>()
    for (const message of messages) {
      const deliberationID = sanitizeRepublicDeliberationID(message.deliberationID)
      const group = groups.get(deliberationID) ?? []
      group.push(message)
      groups.set(deliberationID, group)
    }
    return groups
  }

  function runSupervisorPolicyLoop(sessionID: string): void {
    if (!isRepublicLedgerEnabled(republicConfig) || !(republicConfig?.supervisor?.policy_loop ?? true)) {
      return
    }

    const status = getNativeGitStatus(ctx.directory)
    if (!status) {
      return
    }

    const allMessages = readRepublicCommonsMessages(status.repository)
    if (allMessages.length === 0) {
      return
    }

    for (const [deliberationID, messages] of groupMessagesByDeliberation(allMessages)) {
      const unresolvedQuestions = findUnresolvedQuestions(messages)
      const unresolvedObjections = findUnresolvedObjections(messages)
      const unresolvedSupervisorMessages = messages.filter((message) =>
        message.messageType === "intervention" || message.messageType === "dependency-blocked"
      )
      const unresolvedMessages = [...unresolvedQuestions, ...unresolvedObjections, ...unresolvedSupervisorMessages]
      if (unresolvedMessages.length === 0 || policyAlreadyCovers(messages, unresolvedMessages)) {
        continue
      }

      const latestTimestamp = messages.at(-1)?.timestamp ?? ""
      const policyKey = `${deliberationID}:${messages.length}:${latestTimestamp}:${unresolvedQuestions.length}:${unresolvedObjections.length}:${unresolvedSupervisorMessages.length}`
      if (policyLoopStatusBySession.get(`${sessionID}:${deliberationID}`) === policyKey) {
        continue
      }
      policyLoopStatusBySession.set(`${sessionID}:${deliberationID}`, policyKey)

      const references = [
        ...unresolvedQuestions.map((message) => message.messageID).filter((id): id is string => Boolean(id)),
        ...unresolvedObjections.map((message) => message.messageID).filter((id): id is string => Boolean(id)),
        ...unresolvedSupervisorMessages.map((message) => message.messageID).filter((id): id is string => Boolean(id)),
      ].slice(0, 20)
      const summary = [
        `Supervisor policy loop found ${unresolvedQuestions.length} unresolved question(s), ${unresolvedObjections.length} unresolved objection(s), and ${unresolvedSupervisorMessages.length} unresolved governance warning(s).`,
        "Before continuing execution, affected seats should read republic_inbox and answer, revise, or hand off through republic_publish.",
      ].join("\n")

      appendRepublicCommonsMessage(status.repository, {
        deliberationID,
        channel: "supervisor",
        phase: "policy-loop",
        authorSeatID: "republic-supervisor",
        authorAgent: "republic-supervisor",
        authorRole: "supervisor",
        status: "review-required",
        messageType: "supervisor-policy",
        references,
        content: summary,
      })

      appendRepublicLedgerRecord(status.repository, {
        deliberationID,
        phase: "policy-loop",
        chamber: "supervisor",
        seatID: "republic-supervisor",
        role: "supervisor",
        agent: "republic-supervisor",
        sessionID,
        status: "review-required",
        summary,
      })
    }
  }

  async function showNativeGitReminder(sessionID: string): Promise<void> {
    const dirtyState = dirtyStateBySession.get(sessionID)
    if (!dirtyState) {
      return
    }

    const status = getNativeGitStatus(ctx.directory)
    if (!status?.dirty) {
      dirtyStateBySession.delete(sessionID)
      lastToastStatusBySession.delete(sessionID)
      return
    }

    const statusKey = `${status.repository.repoRoot}:${status.statusKey}`
    if (lastToastStatusBySession.get(sessionID) === statusKey) {
      return
    }

    lastToastStatusBySession.set(sessionID, statusKey)
    await ctx.client.tui
      .showToast({
        body: {
          title: NATIVE_GIT_TOAST_TITLE,
          message: `${NATIVE_GIT_TOAST_MESSAGE} (${dirtyState.fileCount} file${dirtyState.fileCount === 1 ? "" : "s"} dirty.)`,
          variant: "warning" as const,
          duration: 8000,
        },
      })
      .catch((error: unknown) => {
        log("[native-git] failed to show git-master reminder toast", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  function captureNativeGitBaseline(input: NativeGitToolInput): void {
    const tool = input.tool.toLowerCase()
    if (mode === "manual" || !TRACKED_TOOLS.has(tool)) {
      return
    }

    const status = getNativeGitStatus(ctx.directory)
    if (!status) {
      return
    }

    const sessionID = input.sessionID ?? "unknown"
    const statusKey = status.dirty ? status.statusKey : ""
    lastStatusBySessionRepo.set(getStateKey(sessionID, status.repository.repoRoot), statusKey)
    if (!initialStatusByRepo.has(status.repository.repoRoot)) {
      initialStatusByRepo.set(status.repository.repoRoot, statusKey)
    }

    const callKey = getCallKey(input)
    if (callKey) {
      baselineByCall.set(callKey, {
        repositoryRoot: status.repository.repoRoot,
        statusKey,
      })
    }
  }

  function publishRepublicChange(
    repository: NativeGitRepository,
    input: NativeGitToolInput,
    files: string[],
    summary: string,
  ): void {
    if (!isRepublicAutoCommonsEnabled(republicConfig)) {
      return
    }

    const callKey = getCallKey(input)
    if (callKey && republicPublishedCallKeys.has(callKey)) {
      return
    }

    const moduleName = getPrimaryModule(files)
    const workgroupID = getWorkgroupID(moduleName)
    const deliberationID = getDeliberationID(input)
    const seatID = getSeatID(input)
    const taskID = getTaskID(input, moduleName)

    appendRepublicCommonsMessage(repository, {
      deliberationID,
      channel: "native-git",
      phase: "execution",
      authorSeatID: seatID,
      authorAgent: input.agent,
      authorRole: input.category ?? "executor",
      workgroupID,
      module: moduleName,
      taskID,
      status: "changed",
      messageType: "status",
      files,
      content: [
        `Native Git recorded ${files.length} changed file${files.length === 1 ? "" : "s"} from ${input.tool}.`,
        summary.trim(),
      ].join("\n\n"),
    })

    appendRepublicLedgerRecord(repository, {
      deliberationID,
      phase: "execution",
      chamber: "commons",
      seatID,
      role: input.category ?? "executor",
      agent: input.agent,
      model: input.model,
      sessionID: input.sessionID,
      callID: input.callID,
      workgroupID,
      module: moduleName,
      taskID,
      status: "changed",
      files,
      summary,
    })

    if (callKey) {
      republicPublishedCallKeys.add(callKey)
    }
  }

  function recordDependencyGate(
    input: NativeGitToolInput,
    files: string[],
    modules: string[],
    blocked: boolean,
    phase: "preflight" | "post-change" = "preflight",
  ): string | undefined {
    if (!isRepublicLedgerEnabled(republicConfig)) {
      return undefined
    }

    const callKey = getCallKey(input)
    const publishKey = callKey ? `${callKey}:${phase}` : null
    if (publishKey && dependencyGatePublishedCallKeys.has(publishKey)) {
      return undefined
    }

    const status = getNativeGitStatus(ctx.directory)
    if (!status) {
      return undefined
    }

    const moduleName = modules[0] ?? "workspace"
    const workgroupID = getWorkgroupID(moduleName)
    const deliberationID = getDeliberationID(input)
    const taskID = getTaskID(input, moduleName)
    const summary = `Dependency gate ${blocked ? "blocked" : "flagged"} a ${input.tool} call ${phase === "preflight" ? "before execution" : "after observed changes"} across ${modules.length} workgroups: ${modules.join(", ")}.`

    appendRepublicCommonsMessage(status.repository, {
      deliberationID,
      channel: "dependency-gate",
      phase,
      authorSeatID: "dependency-gate",
      authorAgent: "republic-supervisor",
      authorRole: "supervisor",
      targetSeatID: getSeatID(input),
      workgroupID,
      module: moduleName,
      taskID,
      dependsOn: modules.slice(1).map(getWorkgroupID),
      supervisorSeatID: "republic-supervisor",
      status: blocked ? "blocked" : "review-required",
      messageType: "dependency-blocked",
      files,
      content: summary,
    })

    appendRepublicLedgerRecord(status.repository, {
      deliberationID,
      phase,
      chamber: "supervisor",
      seatID: "dependency-gate",
      role: "supervisor",
      agent: "republic-supervisor",
      sessionID: input.sessionID,
      callID: input.callID,
      workgroupID,
      module: moduleName,
      taskID,
      dependsOn: modules.slice(1).map(getWorkgroupID),
      supervisorSeatID: "republic-supervisor",
      status: blocked ? "blocked" : "review-required",
      files,
      summary,
    })

    if (publishKey) {
      dependencyGatePublishedCallKeys.add(publishKey)
    }

    return summary
  }

  function evaluateDependencyGate(
    input: NativeGitToolInput,
    output: { args: Record<string, unknown>; message?: string },
  ): void {
    if (mode === "manual" || !isRepublicLedgerEnabled(republicConfig) || !(republicConfig?.dependency_gate?.enabled ?? true)) {
      return
    }

    const files = getToolTargetPaths(input.tool, output.args)
    const modules = getModules(files)
    const threshold = republicConfig?.dependency_gate?.cross_module_threshold ?? 2
    if (modules.length < threshold) {
      return
    }

    const blocked = (republicConfig?.mode ?? "advisory") === "governed"
      && (republicConfig?.dependency_gate?.mode ?? "advisory") === "block"
    recordDependencyGate(input, files, modules, blocked, "preflight")

    const message = buildDependencyGateMessage(modules, files)
    if (blocked) {
      throw new Error(message.replace(/<\/?system-reminder>/g, "").trim())
    }

    appendBeforeMessage(output, message)
  }

  function publishPostChangeDependencyGate(input: NativeGitToolInput, files: string[]): string | undefined {
    if (mode === "manual" || !isRepublicLedgerEnabled(republicConfig) || !(republicConfig?.dependency_gate?.enabled ?? true)) {
      return undefined
    }

    const modules = getModules(files)
    const threshold = republicConfig?.dependency_gate?.cross_module_threshold ?? 2
    if (modules.length < threshold) {
      return undefined
    }

    const blocked = (republicConfig?.mode ?? "advisory") === "governed"
      && (republicConfig?.dependency_gate?.mode ?? "advisory") === "block"
    return recordDependencyGate(input, files, modules, blocked, "post-change")
  }

  function getSupervisorReasons(input: NativeGitToolInput, files: string[]): string[] {
    if (!isRepublicLedgerEnabled(republicConfig) || !(republicConfig?.supervisor?.intervention ?? true)) {
      return []
    }

    const reasons: string[] = []
    const fileThreshold = republicConfig?.supervisor?.file_threshold ?? 5
    if (files.length >= fileThreshold) {
      reasons.push(`large change set (${files.length} files)`)
    }

    const highRiskPaths = republicConfig?.supervisor?.high_risk_paths ?? []
    const highRiskMatches = files.filter((file) => highRiskPaths.some((pattern) => matchesPathPattern(file, pattern)))
    if (highRiskMatches.length > 0) {
      reasons.push(`high-risk path touched (${highRiskMatches.slice(0, 5).join(", ")})`)
    }

    const agent = input.agent?.toLowerCase()
    const writesOutsidePlanning = files.some((file) => !normalizePath(file).startsWith(".sisyphus/"))
    if (agent === "prometheus" && writesOutsidePlanning) {
      reasons.push("planner agent modified non-planning files")
    }
    if (agent === "atlas" && writesOutsidePlanning) {
      reasons.push("orchestrator agent modified implementation files directly")
    }

    const requestedPaths = input.sessionID ? sessionContextBySession.get(input.sessionID)?.requestedPaths ?? [] : []
    const changedOutsideRequest = requestedPaths.length > 0
      ? files.filter((file) => !requestedPaths.some((requestedPath) => matchesPathPattern(file, requestedPath)))
      : []
    if (changedOutsideRequest.length > 0) {
      reasons.push(
        `changed files outside explicit user-mentioned paths (${changedOutsideRequest.slice(0, 5).join(", ")}; requested ${requestedPaths.slice(0, 5).join(", ")})`,
      )
    }

    return reasons
  }

  function publishSupervisorIntervention(
    repository: NativeGitRepository,
    input: NativeGitToolInput,
    files: string[],
    summary: string,
  ): string | undefined {
    const callKey = getCallKey(input)
    if (callKey && supervisorPublishedCallKeys.has(callKey)) {
      return undefined
    }

    const reasons = getSupervisorReasons(input, files)
    if (reasons.length === 0) {
      return undefined
    }

    const moduleName = getPrimaryModule(files)
    const workgroupID = getWorkgroupID(moduleName)
    const deliberationID = getDeliberationID(input)
    const targetSeatID = getSeatID(input)
    const taskID = getTaskID(input, moduleName)
    const message = [
      `Supervisor review is required because ${reasons.join("; ")}.`,
      "Coordinate affected workgroups through the Republic Commons before treating the task as complete.",
      summary.trim(),
    ].join("\n\n")

    appendRepublicCommonsMessage(repository, {
      deliberationID,
      channel: "supervisor",
      phase: "intervention",
      authorSeatID: "republic-supervisor",
      authorAgent: "republic-supervisor",
      authorRole: "supervisor",
      targetSeatID,
      workgroupID,
      module: moduleName,
      taskID,
      supervisorSeatID: "republic-supervisor",
      status: "review-required",
      messageType: "intervention",
      files,
      content: message,
    })

    appendRepublicLedgerRecord(repository, {
      deliberationID,
      phase: "intervention",
      chamber: "supervisor",
      seatID: "republic-supervisor",
      role: "supervisor",
      agent: "republic-supervisor",
      sessionID: input.sessionID,
      callID: input.callID,
      workgroupID,
      module: moduleName,
      taskID,
      supervisorSeatID: "republic-supervisor",
      status: "review-required",
      files,
      summary: message,
    })

    if (callKey) {
      supervisorPublishedCallKeys.add(callKey)
    }

    return message
  }

  function trackNativeGitChanges(input: NativeGitToolInput): NativeGitTrackResult {
    input = enrichToolInput(input)
    const tool = input.tool.toLowerCase()
    if (mode === "manual" || !TRACKED_TOOLS.has(tool)) {
      return { dirty: false, changedSinceLastCheck: false }
    }

    const status = getNativeGitStatus(ctx.directory)
    if (!status) {
      return { dirty: false, changedSinceLastCheck: false }
    }

    const sessionID = input.sessionID ?? "unknown"
    const stateKey = getStateKey(sessionID, status.repository.repoRoot)
    const callKey = getCallKey(input)
    const cachedResult = callKey ? changedResultByCall.get(callKey) : undefined
    if (cachedResult) {
      return cachedResult
    }

    if (!status.dirty) {
      lastStatusBySessionRepo.set(stateKey, "")
      dirtyStateBySession.delete(sessionID)
      if (callKey) {
        baselineByCall.delete(callKey)
        changedResultByCall.delete(callKey)
      }
      return { dirty: false, changedSinceLastCheck: false }
    }

    const baseline = callKey ? baselineByCall.get(callKey) : undefined
    const previousStatusKey =
      baseline?.repositoryRoot === status.repository.repoRoot
        ? baseline.statusKey
        : (lastStatusBySessionRepo.get(stateKey) ?? initialStatusByRepo.get(status.repository.repoRoot) ?? "")
    const changedSinceLastCheck = previousStatusKey !== status.statusKey
    lastStatusBySessionRepo.set(stateKey, status.statusKey)

    if (callKey) {
      baselineByCall.delete(callKey)
    }

    const summary = getNativeGitChangeSummary(ctx.directory)
    dirtyStateBySession.set(sessionID, {
      fileCount: status.files.length,
    })

    let supervisorMessage: string | undefined
    let dependencyGateMessage: string | undefined
    if (changedSinceLastCheck) {
      if (auditLog && (!callKey || !auditedCallKeys.has(callKey))) {
        appendNativeGitAuditRecord(status.repository, {
          tool,
          sessionID: input.sessionID,
          callID: input.callID,
          agent: input.agent,
          model: input.model,
          category: input.category,
          files: status.files,
          summary,
        })

        if (callKey) {
          auditedCallKeys.add(callKey)
        }
      }

      publishRepublicChange(status.repository, input, status.files, summary)
      dependencyGateMessage = publishPostChangeDependencyGate(input, status.files)
      supervisorMessage = publishSupervisorIntervention(status.repository, input, status.files, summary)

      log("[native-git] tracked uncommitted changes", {
        tool,
        sessionID: input.sessionID,
        fileCount: status.files.length,
      })
    }

    const result = { dirty: true, changedSinceLastCheck, summary, supervisorMessage, dependencyGateMessage }
    if (callKey && changedSinceLastCheck) {
      changedResultByCall.set(callKey, result)
    }

    return result
  }

  return {
    "chat.message": async (input: NativeGitChatInput, output?: NativeGitChatOutput): Promise<void> => {
      if (mode !== "manual") {
        rememberSessionContext(input)
        injectRepublicInbox(input, output)
      }
    },
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown>; message?: string },
    ): Promise<void> => {
      evaluateDependencyGate(enrichToolInput(input), output)
    },
    event: async (input: NativeGitEventInput): Promise<void> => {
      if (mode === "manual") {
        return
      }

      if (input.event.type === "session.deleted" && isRecord(input.event.properties)) {
        const info = isRecord(input.event.properties.info) ? input.event.properties.info : undefined
        const sessionID =
          getStringProperty(input.event.properties, ["sessionID", "sessionId"]) ??
          (info ? getStringProperty(info, ["id"]) : undefined)
        if (sessionID) {
          clearSessionState(sessionID)
        }
        return
      }

      if (input.event.type === "session.idle" && isRecord(input.event.properties)) {
        const sessionID = getStringProperty(input.event.properties, ["sessionID", "sessionId"])
        if (sessionID) {
          runSupervisorPolicyLoop(sessionID)
          await showNativeGitReminder(sessionID)
        }
        return
      }

      const toolInput = getNativeGitToolInputFromEvent(input)
      if (!toolInput) {
        return
      }

      if (input.event.type === "tool.execute") {
        captureNativeGitBaseline(toolInput)
        return
      }

      trackNativeGitChanges(toolInput)
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { output?: string; metadata?: Record<string, unknown> } | undefined,
    ): Promise<void> => {
      if (!output || mode === "manual") {
        return
      }

      const tool = input.tool.toLowerCase()
      if (!TRACKED_TOOLS.has(tool)) {
        return
      }

      const enrichedInput = enrichToolInput(mergeToolOutputMetadata(input, output.metadata))
      const result = trackNativeGitChanges(enrichedInput)
      const callKey = getCallKey(input)
      if (result.changedSinceLastCheck && result.summary && (!callKey || !outputReminderCallKeys.has(callKey))) {
        if (tool !== "task") {
          appendOutput(output, buildTrackingMessage(result.summary))
        }
        if (callKey) {
          outputReminderCallKeys.add(callKey)
        }
      }

      if (result.dependencyGateMessage && (!callKey || !dependencyGateReminderCallKeys.has(callKey))) {
        appendOutput(output, buildPostChangeDependencyGateMessage(result.dependencyGateMessage))
        if (callKey) {
          dependencyGateReminderCallKeys.add(callKey)
        }
      }

      if (result.supervisorMessage && (!callKey || !supervisorReminderCallKeys.has(callKey))) {
        appendOutput(output, buildSupervisorInterventionMessage(result.supervisorMessage))
        if (callKey) {
          supervisorReminderCallKeys.add(callKey)
        }
      }

      if (tool === "task" && result.dirty && (!callKey || !taskReminderCallKeys.has(callKey))) {
        appendOutput(output, NATIVE_GIT_TASK_REMINDER)
        if (callKey) {
          taskReminderCallKeys.add(callKey)
        }
      }
    },
  }
}
