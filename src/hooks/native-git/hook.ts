import type { PluginInput } from "@opencode-ai/plugin"
import type { NativeGitConfig, RepublicConfig } from "../../config"
import {
  appendNativeGitAuditRecord,
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  getNativeGitChangeSummary,
  getNativeGitStatus,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
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
}

type NativeGitSessionContext = {
  agent?: string
  model?: string
  category?: string
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
  const outputReminderCallKeys = new Set<string>()
  const taskReminderCallKeys = new Set<string>()
  const initialStatusByRepo = new Map<string, string>()
  const sessionContextBySession = new Map<string, NativeGitSessionContext>()

  const initialStatus = mode === "manual" ? null : getNativeGitStatus(ctx.directory)
  if (initialStatus) {
    initialStatusByRepo.set(initialStatus.repository.repoRoot, initialStatus.dirty ? initialStatus.statusKey : "")
  }

  function clearSessionState(sessionID: string): void {
    dirtyStateBySession.delete(sessionID)
    lastToastStatusBySession.delete(sessionID)
    sessionContextBySession.delete(sessionID)
    deleteSessionMapEntries(lastStatusBySessionRepo, sessionID)
    deleteSessionMapEntries(baselineByCall, sessionID)
    deleteSessionMapEntries(changedResultByCall, sessionID)

    for (const set of [auditedCallKeys, republicPublishedCallKeys, outputReminderCallKeys, taskReminderCallKeys]) {
      for (const key of set) {
        if (key.startsWith(`${sessionID}:`)) {
          set.delete(key)
        }
      }
    }
  }

  function rememberSessionContext(input: NativeGitChatInput): void {
    sessionContextBySession.set(input.sessionID, {
      agent: normalizeAgent(input.agent),
      model: formatModelID(input.model),
      category: input.category,
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

      log("[native-git] tracked uncommitted changes", {
        tool,
        sessionID: input.sessionID,
        fileCount: status.files.length,
      })
    }

    const result = { dirty: true, changedSinceLastCheck, summary }
    if (callKey && changedSinceLastCheck) {
      changedResultByCall.set(callKey, result)
    }

    return result
  }

  return {
    "chat.message": async (input: NativeGitChatInput): Promise<void> => {
      if (mode !== "manual") {
        rememberSessionContext(input)
      }
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

      if (tool === "task" && result.dirty && (!callKey || !taskReminderCallKeys.has(callKey))) {
        appendOutput(output, NATIVE_GIT_TASK_REMINDER)
        if (callKey) {
          taskReminderCallKeys.add(callKey)
        }
      }
    },
  }
}
