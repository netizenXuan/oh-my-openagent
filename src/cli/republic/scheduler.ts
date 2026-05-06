import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import {
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
  readRepublicSchedulerQueueRecords,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
  type RepublicSchedulerQueueRecord,
} from "../../shared/git-worktree"

export interface RepublicSchedulerOptions {
  directory?: string
  deliberationId?: string
  limit?: number
  writePrompts?: boolean
  commandTemplate?: string
  watch?: boolean
  pollIntervalMs?: number
  maxCycles?: number
  json?: boolean
}

export interface RepublicSchedulerAction {
  dispatchID: string
  status: "queued" | "prompt-written" | "dispatched" | "failed"
  queueType: RepublicSchedulerQueueRecord["queueType"]
  targetSeatID?: string
  requestedAgent?: string
  runtimeAgent?: string
  promptPath?: string
  command?: string
  exitCode?: number | null
  reason?: string
  summary: string
}

export interface RepublicSchedulerPlan {
  generatedAt: string
  repository: NativeGitRepository | null
  queuedCount: number
  actions: RepublicSchedulerAction[]
}

function latestQueueRecords(records: RepublicSchedulerQueueRecord[]): Map<string, RepublicSchedulerQueueRecord> {
  const latest = new Map<string, RepublicSchedulerQueueRecord>()
  for (const record of records) {
    const dispatchID = record.dispatchID
    if (!dispatchID) continue
    const current = latest.get(dispatchID)
    if (!current || String(record.timestamp ?? "") >= String(current.timestamp ?? "")) {
      latest.set(dispatchID, record)
    }
  }
  return latest
}

function pendingQueueRecords(records: RepublicSchedulerQueueRecord[]): RepublicSchedulerQueueRecord[] {
  return Array.from(latestQueueRecords(records).values())
    .filter((record) => record.status === "queued")
    .sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? "")))
}

function schedulerPromptsDir(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "scheduler", "prompts")
}

function schedulerPromptPath(repository: NativeGitRepository, dispatchID: string): string {
  return join(schedulerPromptsDir(repository), `${sanitizeRepublicDeliberationID(dispatchID)}.md`)
}

function responseType(record: RepublicSchedulerQueueRecord): string {
  if (record.queueType === "supervisor-review") {
    return "consensus, revision, or objection"
  }
  return record.sourceMessageType === "question" ? "answer" : "revision or handoff"
}

function buildWakePrompt(repository: NativeGitRepository, record: RepublicSchedulerQueueRecord): string {
  const dispatchID = record.dispatchID ?? "unknown-dispatch"
  const targetSeatID = record.targetSeatID ?? "target-seat"
  const references = record.sourceMessageID ? `["${record.sourceMessageID}"]` : "[]"
  const messageTypes = responseType(record)
  const lines = [
    "# OMO Republic Scheduler Wake Prompt",
    "",
    `Repository: ${repository.repoRoot}`,
    `Dispatch: ${dispatchID}`,
    `Queue type: ${record.queueType}`,
    `Target seat: ${targetSeatID}`,
    `Requested agent: ${record.requestedAgent ?? "default"}`,
    `Deliberation: ${record.deliberationID}`,
    record.workgroupID ? `Workgroup: ${record.workgroupID}` : undefined,
    record.module ? `Module: ${record.module}` : undefined,
    record.sourceMessageID ? `Source message: ${record.sourceMessageID}` : undefined,
    record.sourceMessageType ? `Source type: ${record.sourceMessageType}` : undefined,
    record.files?.length ? `Files: ${record.files.join(", ")}` : undefined,
    "",
    "Protocol:",
    `1. Work as persistent Republic seat "${targetSeatID}".`,
    `2. Read republic_inbox for "${targetSeatID}" before answering.`,
    `3. Respond with republic_publish using message_type="${messageTypes}", author_seat_id="${targetSeatID}", references=${references}, deliberation_id="${record.deliberationID}".`,
    "4. If the answer changes an interface, publish or revise the relevant republic_contract before implementation.",
    "5. If the seat is blocked or disagrees, publish objection or handoff instead of silently continuing.",
    "6. Stop after publishing the response, handoff, objection, or supervisor decision.",
    "",
    "Original queued summary:",
    record.summary ?? record.reason ?? "No summary recorded.",
  ]
  return `${lines.filter((line): line is string => typeof line === "string").join("\n")}\n`
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function renderCommandTemplate(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\{([a-zA-Z_]+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : shellQuote(value)
  })
}

export function buildRepublicSchedulerPlan(options: RepublicSchedulerOptions = {}): RepublicSchedulerPlan {
  const directory = options.directory ?? process.cwd()
  const repository = getNativeGitRepository(directory)
  if (!repository) {
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      queuedCount: 0,
      actions: [],
    }
  }

  const limit = options.limit && options.limit > 0 ? options.limit : 5
  const queued = pendingQueueRecords(readRepublicSchedulerQueueRecords(repository, options.deliberationId)).slice(0, limit)
  const actions: RepublicSchedulerAction[] = []

  for (const record of queued) {
    const dispatchID = record.dispatchID ?? sanitizeRepublicDeliberationID(`${record.deliberationID}-${record.targetSeatID ?? "seat"}`)
    const promptPath = schedulerPromptPath(repository, dispatchID)
    let promptWritten = false
    if (options.writePrompts || options.commandTemplate) {
      mkdirSync(dirname(promptPath), { recursive: true })
      writeFileSync(promptPath, buildWakePrompt(repository, record), "utf-8")
      promptWritten = true
    }

    if (!options.commandTemplate) {
      actions.push({
        dispatchID,
        status: promptWritten ? "prompt-written" : "queued",
        queueType: record.queueType,
        targetSeatID: record.targetSeatID,
        requestedAgent: record.requestedAgent,
        promptPath: promptWritten ? promptPath : undefined,
        reason: promptWritten ? "prompt_written_without_launch" : "no_command_template",
        summary: record.summary ?? "Queued dispatch is waiting for an external scheduler.",
      })
      continue
    }

    const command = renderCommandTemplate(options.commandTemplate, {
      repo: repository.repoRoot,
      prompt: promptPath,
      dispatch_id: dispatchID,
      target_seat: record.targetSeatID,
      agent: record.requestedAgent,
      deliberation_id: record.deliberationID,
    })
    const result = spawnSync(command, {
      cwd: repository.repoRoot,
      shell: true,
      stdio: "inherit",
    })
    const succeeded = result.status === 0
    appendRepublicSchedulerQueueRecord(repository, {
      ...record,
      dispatchID,
      status: succeeded ? "dispatched" : "failed",
      runtimeAgent: record.requestedAgent,
      taskID: `external:${dispatchID}`,
      reason: succeeded ? "external_scheduler_command_completed" : "external_scheduler_command_failed",
      summary: succeeded
        ? `External Republic scheduler launched ${record.targetSeatID ?? "target seat"} with ${record.requestedAgent ?? "default agent"}.`
        : `External Republic scheduler command failed for ${record.targetSeatID ?? "target seat"}.`,
    })
    actions.push({
      dispatchID,
      status: succeeded ? "dispatched" : "failed",
      queueType: record.queueType,
      targetSeatID: record.targetSeatID,
      requestedAgent: record.requestedAgent,
      runtimeAgent: record.requestedAgent,
      promptPath,
      command,
      exitCode: result.status,
      reason: succeeded ? "external_scheduler_command_completed" : "external_scheduler_command_failed",
      summary: succeeded
        ? `Launched ${record.targetSeatID ?? "target seat"} from scheduler queue.`
        : `Failed to launch ${record.targetSeatID ?? "target seat"} from scheduler queue.`,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    repository,
    queuedCount: queued.length,
    actions,
  }
}

function formatAction(action: RepublicSchedulerAction): string {
  return [
    `- ${action.dispatchID}: ${action.status}`,
    action.targetSeatID ? `  target: ${action.targetSeatID}` : undefined,
    action.requestedAgent ? `  requested_agent: ${action.requestedAgent}` : undefined,
    action.promptPath ? `  prompt: ${action.promptPath}` : undefined,
    action.reason ? `  reason: ${action.reason}` : undefined,
    `  summary: ${action.summary}`,
  ].filter((line): line is string => typeof line === "string").join("\n")
}

export function formatRepublicSchedulerPlan(plan: RepublicSchedulerPlan): string {
  if (!plan.repository) {
    return "OMO Republic Scheduler\n\nNot inside a git repository. No scheduler queue can be read."
  }

  return [
    "OMO Republic Scheduler",
    "",
    `Repository: ${plan.repository.repoRoot}`,
    `Generated: ${plan.generatedAt}`,
    `Queued dispatches selected: ${plan.queuedCount}`,
    "",
    plan.actions.length > 0
      ? plan.actions.map(formatAction).join("\n\n")
      : "No queued scheduler dispatches.",
  ].join("\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function printSchedulerPlan(plan: RepublicSchedulerPlan, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(plan, null, 2))
  } else {
    console.log(formatRepublicSchedulerPlan(plan))
  }
}

export async function republicScheduler(options: RepublicSchedulerOptions = {}): Promise<number> {
  if (options.watch) {
    const pollIntervalMs = options.pollIntervalMs && options.pollIntervalMs > 0 ? options.pollIntervalMs : 5000
    const maxCycles = options.maxCycles && options.maxCycles > 0 ? options.maxCycles : Number.POSITIVE_INFINITY
    let cycle = 0
    let exitCode = 0
    while (cycle < maxCycles) {
      const plan = buildRepublicSchedulerPlan(options)
      printSchedulerPlan(plan, options.json)
      if (!plan.repository) {
        return 1
      }
      if (plan.actions.some((action) => action.status === "failed")) {
        exitCode = 1
      }
      cycle += 1
      if (cycle >= maxCycles) {
        break
      }
      await sleep(pollIntervalMs)
    }
    return exitCode
  }

  const plan = buildRepublicSchedulerPlan(options)
  printSchedulerPlan(plan, options.json)
  if (!plan.repository) {
    return 1
  }
  return plan.actions.some((action) => action.status === "failed") ? 1 : 0
}
