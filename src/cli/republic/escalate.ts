import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  appendRepublicCommonsMessage,
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
  readRepublicSchedulerQueueRecords,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
  type RepublicSchedulerQueueRecord,
} from "../../shared/git-worktree"
import { buildRepublicSchedulerPlan, type RepublicSchedulerAction } from "./scheduler"

export type RepublicEscalationActionStatus = "planned" | "queued" | "dispatched" | "failed" | "skipped"

export interface RepublicEscalationAction {
  source: string
  dispatchID: string
  status: RepublicEscalationActionStatus
  reason: string
  targetSeatID?: string
  requestedAgent: string
  failedCount?: number
  pendingAgeMs?: number
  schedulerAction?: RepublicSchedulerAction
}

export interface RepublicEscalationReport {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID?: string
  applied: boolean
  escalationAgent: string
  maxFailedPerSource: number
  maxPendingAgeMs?: number
  actions: RepublicEscalationAction[]
}

export interface RepublicEscalationOptions {
  directory?: string
  deliberationId?: string
  maxFailedPerSource?: number
  maxPendingAgeMs?: number
  escalationAgent?: string
  apply?: boolean
  commandTemplate?: string
  now?: Date
  output?: string
  json?: boolean
}

function latestQueueRecords(records: RepublicSchedulerQueueRecord[]): RepublicSchedulerQueueRecord[] {
  const latest = new Map<string, RepublicSchedulerQueueRecord>()
  for (const record of records) {
    const key = record.dispatchID ?? [
      record.deliberationID,
      record.queueType,
      record.targetSeatID ?? "broadcast",
      record.sourceMessageID ?? "source",
    ].join(":")
    const current = latest.get(key)
    if (!current || String(record.timestamp ?? "") >= String(current.timestamp ?? "")) {
      latest.set(key, record)
    }
  }
  return Array.from(latest.values())
}

function sourceKey(record: RepublicSchedulerQueueRecord): string {
  return record.sourceMessageID ?? record.targetSeatID ?? record.dispatchID ?? "unknown-source"
}

function latestRecord(records: RepublicSchedulerQueueRecord[]): RepublicSchedulerQueueRecord {
  return records.slice().sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")))[0]!
}

function escalationDispatchID(reason: string, source: string, agent: string): string {
  return sanitizeRepublicDeliberationID(`escalate-${reason}-${source}-${agent}`).slice(0, 140)
}

function alreadyEscalated(records: RepublicSchedulerQueueRecord[], dispatchID: string): boolean {
  return records.some((record) => record.dispatchID === dispatchID && record.status !== "failed")
}

function failedBurstActions(
  records: RepublicSchedulerQueueRecord[],
  options: {
    maxFailedPerSource: number
    escalationAgent: string
  },
): RepublicEscalationAction[] {
  const groups = new Map<string, RepublicSchedulerQueueRecord[]>()
  for (const record of records) {
    if (record.status !== "failed") continue
    const source = sourceKey(record)
    groups.set(source, (groups.get(source) ?? []).concat(record))
  }

  const actions: RepublicEscalationAction[] = []
  for (const [source, failures] of groups) {
    if (failures.length <= options.maxFailedPerSource) continue
    const record = latestRecord(failures)
    const dispatchID = escalationDispatchID("failed-burst", source, options.escalationAgent)
    actions.push({
      source,
      dispatchID,
      status: alreadyEscalated(records, dispatchID) ? "skipped" : "planned",
      reason: alreadyEscalated(records, dispatchID) ? "already_escalated" : "failed_burst",
      targetSeatID: record.targetSeatID,
      requestedAgent: options.escalationAgent,
      failedCount: failures.length,
    })
  }
  return actions
}

function pendingTTLActions(
  records: RepublicSchedulerQueueRecord[],
  options: {
    maxPendingAgeMs?: number
    escalationAgent: string
    now: Date
  },
): RepublicEscalationAction[] {
  if (typeof options.maxPendingAgeMs !== "number") return []
  const actions: RepublicEscalationAction[] = []
  for (const record of latestQueueRecords(records)) {
    if (record.status !== "queued" || !record.timestamp) continue
    const age = options.now.getTime() - new Date(record.timestamp).getTime()
    if (Number.isNaN(age) || age <= options.maxPendingAgeMs) continue
    const source = sourceKey(record)
    const dispatchID = escalationDispatchID("pending-ttl", source, options.escalationAgent)
    actions.push({
      source,
      dispatchID,
      status: alreadyEscalated(records, dispatchID) ? "skipped" : "planned",
      reason: alreadyEscalated(records, dispatchID) ? "already_escalated" : "pending_ttl",
      targetSeatID: record.targetSeatID,
      requestedAgent: options.escalationAgent,
      pendingAgeMs: age,
    })
  }
  return actions
}

function sourceRecordForAction(records: RepublicSchedulerQueueRecord[], action: RepublicEscalationAction): RepublicSchedulerQueueRecord | undefined {
  return records
    .filter((record) => sourceKey(record) === action.source)
    .sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")))[0]
}

function applyEscalation(
  repository: NativeGitRepository,
  action: RepublicEscalationAction,
  sourceRecord: RepublicSchedulerQueueRecord,
): RepublicEscalationAction {
  appendRepublicCommonsMessage(repository, {
    deliberationID: sourceRecord.deliberationID,
    channel: "governance",
    phase: sourceRecord.phase ?? "execution",
    authorSeatID: "republic-supervisor",
    targetSeatID: sourceRecord.targetSeatID,
    messageType: "intervention",
    status: "escalated",
    references: sourceRecord.sourceMessageID ? [sourceRecord.sourceMessageID] : undefined,
    workgroupID: sourceRecord.workgroupID,
    module: sourceRecord.module,
    files: sourceRecord.files,
    content: `Auto-escalation triggered for ${action.source}: ${action.reason}. Reassigning to ${action.requestedAgent}.`,
  })
  appendRepublicSchedulerQueueRecord(repository, {
    ...sourceRecord,
    dispatchID: action.dispatchID,
    status: "queued",
    requestedAgent: action.requestedAgent,
    runtimeAgent: undefined,
    reason: `auto_escalation_${action.reason}`,
    summary: `Auto-escalated ${action.source} to ${action.requestedAgent}.`,
  })
  return { ...action, status: "queued" }
}

export function buildRepublicEscalationReport(options: RepublicEscalationOptions = {}): RepublicEscalationReport {
  const directory = resolve(options.directory ?? process.cwd())
  const repository = getNativeGitRepository(directory)
  const deliberationID = options.deliberationId ? sanitizeRepublicDeliberationID(options.deliberationId) : undefined
  const escalationAgent = options.escalationAgent ?? "hephaestus"
  const maxFailedPerSource = Math.max(0, options.maxFailedPerSource ?? 1)
  const now = options.now ?? new Date()
  const apply = options.apply ?? false

  if (!repository) {
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      deliberationID,
      applied: false,
      escalationAgent,
      maxFailedPerSource,
      maxPendingAgeMs: options.maxPendingAgeMs,
      actions: [],
    }
  }

  const records = readRepublicSchedulerQueueRecords(repository, deliberationID)
  let actions = [
    ...failedBurstActions(records, { maxFailedPerSource, escalationAgent }),
    ...pendingTTLActions(records, { maxPendingAgeMs: options.maxPendingAgeMs, escalationAgent, now }),
  ]

  if (apply) {
    actions = actions.map((action) => {
      if (action.status !== "planned") return action
      const sourceRecord = sourceRecordForAction(records, action)
      return sourceRecord ? applyEscalation(repository, action, sourceRecord) : { ...action, status: "failed", reason: "source_record_missing" }
    })
  }

  if (apply && options.commandTemplate && actions.some((action) => action.status === "queued")) {
    const schedulerPlan = buildRepublicSchedulerPlan({
      directory,
      deliberationId: deliberationID,
      limit: actions.filter((action) => action.status === "queued").length,
      writePrompts: true,
      commandTemplate: options.commandTemplate,
    })
    const schedulerByDispatchID = new Map(schedulerPlan.actions.map((action) => [action.dispatchID, action]))
    actions = actions.map((action) => {
      const schedulerAction = schedulerByDispatchID.get(action.dispatchID)
      if (!schedulerAction) return action
      return {
        ...action,
        status: schedulerAction.status === "dispatched" ? "dispatched" : schedulerAction.status === "failed" ? "failed" : action.status,
        schedulerAction,
      }
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    applied: apply,
    escalationAgent,
    maxFailedPerSource,
    maxPendingAgeMs: options.maxPendingAgeMs,
    actions,
  }
}

export function formatRepublicEscalationReport(report: RepublicEscalationReport): string {
  if (!report.repository) {
    return "OMO Republic Escalation\n\nNot inside a git repository. No scheduler queue can be escalated."
  }

  const lines = [
    "# OMO Republic Escalation",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository.repoRoot}`,
    report.deliberationID ? `Deliberation: ${report.deliberationID}` : undefined,
    `Mode: ${report.applied ? "apply" : "plan"}`,
    `Escalation agent: ${report.escalationAgent}`,
    `Failed threshold: > ${report.maxFailedPerSource}`,
    report.maxPendingAgeMs !== undefined ? `Pending TTL: ${report.maxPendingAgeMs}ms` : undefined,
    "",
    "| Source | Dispatch | Status | Reason | Target | Agent |",
    "| --- | --- | --- | --- | --- | --- |",
  ].filter((line): line is string => typeof line === "string")

  if (report.actions.length === 0) {
    lines.push("| none | none | skipped | no escalation candidates | none | none |")
  } else {
    for (const action of report.actions) {
      lines.push(`| ${action.source} | ${action.dispatchID} | ${action.status} | ${action.reason} | ${action.targetSeatID ?? ""} | ${action.requestedAgent} |`)
    }
  }
  return lines.join("\n")
}

export async function republicEscalate(options: RepublicEscalationOptions = {}): Promise<number> {
  const report = buildRepublicEscalationReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicEscalationReport(report)

  if (options.output) {
    const outputPath = resolve(options.output)
    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }
    writeFileSync(outputPath, content + "\n", "utf-8")
  } else {
    console.log(content)
  }

  if (!report.repository) return 1
  return report.actions.some((action) => action.status === "failed") ? 1 : 0
}
