import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  getNativeGitRepository,
  getNativeGitStatus,
  readRepublicCommonsMessages,
  readRepublicSchedulerQueueRecords,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
  type RepublicCommonsMessage,
  type RepublicSchedulerQueueRecord,
} from "../../shared/git-worktree"

export type RepublicCapabilityCheckStatus = "pass" | "fail" | "warn"

export interface RepublicCapabilityCheck {
  name: string
  status: RepublicCapabilityCheckStatus
  detail: string
}

export interface RepublicCapabilityExpected {
  dispatchID?: string
  sourceMessageID?: string
  authorSeatID?: string
  targetSeatID?: string
  messageType?: RepublicCommonsMessage["messageType"]
  contentTerms: string[]
  cleanWorktree: boolean
  dispatchedQueue: boolean
  allowIndirect: boolean
}

export interface RepublicCapabilityReport {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID?: string
  expected: RepublicCapabilityExpected
  passed: boolean
  failures: number
  warnings: number
  checks: RepublicCapabilityCheck[]
  matchingResponses: RepublicCommonsMessage[]
  matchingQueueRecords: RepublicSchedulerQueueRecord[]
  dirtyFiles: string[]
}

export interface RepublicCapabilityOptions {
  directory?: string
  deliberationId?: string
  dispatchId?: string
  sourceMessageId?: string
  expectedAuthorSeat?: string
  expectedTargetSeat?: string
  expectedMessageType?: RepublicCommonsMessage["messageType"]
  requireContent?: string[]
  expectCleanWorktree?: boolean
  requireDispatchedQueue?: boolean
  allowIndirect?: boolean
  output?: string
  json?: boolean
}

function addCheck(checks: RepublicCapabilityCheck[], check: RepublicCapabilityCheck): void {
  checks.push(check)
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

function matchesExpectedResponse(
  message: RepublicCommonsMessage,
  expected: RepublicCapabilityExpected,
  messages: RepublicCommonsMessage[],
): boolean {
  if (
    expected.sourceMessageID &&
    !messageReferencesSource(message, expected.sourceMessageID, messages, expected.allowIndirect)
  ) {
    return false
  }
  if (expected.authorSeatID && message.authorSeatID !== expected.authorSeatID) return false
  if (expected.targetSeatID && message.targetSeatID !== expected.targetSeatID) return false
  if (expected.messageType && message.messageType !== expected.messageType) return false
  return true
}

function messageReferencesSource(
  message: RepublicCommonsMessage,
  sourceMessageID: string,
  messages: RepublicCommonsMessage[],
  allowIndirect: boolean,
): boolean {
  const directReferences = message.references ?? []
  if (directReferences.includes(sourceMessageID)) return true
  if (!allowIndirect) return false

  const byID = new Map(messages.map((candidate) => [candidate.messageID, candidate]))
  const seen = new Set<string>()
  const queue = [...directReferences]
  while (queue.length > 0) {
    const currentID = queue.shift()
    if (!currentID || seen.has(currentID)) continue
    if (currentID === sourceMessageID) return true
    seen.add(currentID)
    const current = byID.get(currentID)
    if (current?.references?.length) {
      queue.push(...current.references)
    }
  }
  return false
}

function matchingQueueRecords(
  records: RepublicSchedulerQueueRecord[],
  expected: RepublicCapabilityExpected,
): RepublicSchedulerQueueRecord[] {
  return latestQueueRecords(records).filter((record) => {
    if (expected.dispatchID && record.dispatchID !== expected.dispatchID) return false
    if (expected.sourceMessageID && record.sourceMessageID !== expected.sourceMessageID) return false
    if (expected.authorSeatID && record.targetSeatID !== expected.authorSeatID) return false
    return true
  })
}

function statusCounts(records: RepublicSchedulerQueueRecord[]): string {
  const counts = new Map<string, number>()
  for (const record of records) {
    counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(", ") || "none"
}

function normalizeMessageType(
  value: string | undefined,
): RepublicCommonsMessage["messageType"] | undefined {
  if (!value) return undefined
  const allowed = new Set([
    "proposal",
    "question",
    "answer",
    "objection",
    "revision",
    "handoff",
    "consensus",
    "contract",
    "note",
    "status",
    "intervention",
    "dependency-blocked",
    "supervisor-policy",
  ])
  if (!allowed.has(value)) {
    throw new Error(`Unsupported Republic message type: ${value}`)
  }
  return value as RepublicCommonsMessage["messageType"]
}

export function buildRepublicCapabilityReport(options: RepublicCapabilityOptions = {}): RepublicCapabilityReport {
  const directory = options.directory ?? process.cwd()
  const repository = getNativeGitRepository(directory)
  const expected: RepublicCapabilityExpected = {
    dispatchID: options.dispatchId,
    sourceMessageID: options.sourceMessageId,
    authorSeatID: options.expectedAuthorSeat,
    targetSeatID: options.expectedTargetSeat,
    messageType: normalizeMessageType(options.expectedMessageType ?? "answer"),
    contentTerms: options.requireContent ?? [],
    cleanWorktree: options.expectCleanWorktree ?? false,
    dispatchedQueue: options.requireDispatchedQueue ?? false,
    allowIndirect: options.allowIndirect ?? false,
  }
  const checks: RepublicCapabilityCheck[] = []

  if (!repository) {
    addCheck(checks, {
      name: "repository",
      status: "fail",
      detail: `No git repository found from ${resolve(directory)}.`,
    })
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      deliberationID: options.deliberationId,
      expected,
      passed: false,
      failures: 1,
      warnings: 0,
      checks,
      matchingResponses: [],
      matchingQueueRecords: [],
      dirtyFiles: [],
    }
  }

  addCheck(checks, {
    name: "repository",
    status: "pass",
    detail: `Repository root: ${repository.repoRoot}.`,
  })

  const gitStatus = getNativeGitStatus(repository.repoRoot)
  const dirtyFiles = gitStatus?.files ?? []
  if (expected.cleanWorktree) {
    addCheck(checks, {
      name: "clean-worktree",
      status: dirtyFiles.length === 0 ? "pass" : "fail",
      detail: dirtyFiles.length === 0
        ? "Git worktree is clean."
        : `Git worktree has ${dirtyFiles.length} dirty file(s): ${dirtyFiles.join(", ")}.`,
    })
  }

  const deliberationID = options.deliberationId
    ? sanitizeRepublicDeliberationID(options.deliberationId)
    : undefined
  const messages = readRepublicCommonsMessages(repository, deliberationID)
  const matchingResponses = messages.filter((message) => matchesExpectedResponse(message, expected, messages))
  addCheck(checks, {
    name: "commons-response",
    status: matchingResponses.length > 0 ? "pass" : "fail",
    detail: matchingResponses.length > 0
      ? `Found ${matchingResponses.length} matching Commons response(s).`
      : `No Commons response matched the expected source${expected.allowIndirect ? " graph" : ""}, seat, target, and type fields.`,
  })

  for (const term of expected.contentTerms) {
    const matched = matchingResponses.some((message) => message.content.includes(term))
    addCheck(checks, {
      name: `content:${term}`,
      status: matched ? "pass" : "fail",
      detail: matched
        ? `A matching response contains "${term}".`
        : `No matching response contains required term "${term}".`,
    })
  }

  const queueRecords = readRepublicSchedulerQueueRecords(repository, deliberationID)
  const matchingQueues = matchingQueueRecords(queueRecords, expected)
  if (expected.dispatchedQueue) {
    const hasDispatched = matchingQueues.some((record) => record.status === "dispatched")
    addCheck(checks, {
      name: "scheduler-dispatch",
      status: hasDispatched ? "pass" : "fail",
      detail: hasDispatched
        ? `Matching scheduler queue latest statuses: ${statusCounts(matchingQueues)}.`
        : `No matching dispatch reached dispatched status. Latest statuses: ${statusCounts(matchingQueues)}.`,
    })
  }

  const failures = checks.filter((check) => check.status === "fail").length
  const warnings = checks.filter((check) => check.status === "warn").length
  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    expected,
    passed: failures === 0,
    failures,
    warnings,
    checks,
    matchingResponses,
    matchingQueueRecords: matchingQueues,
    dirtyFiles,
  }
}

function formatCheck(check: RepublicCapabilityCheck): string {
  return `| ${check.name} | ${check.status} | ${check.detail.replace(/\|/g, "\\|")} |`
}

export function formatRepublicCapabilityReport(report: RepublicCapabilityReport): string {
  const lines = [
    "# OMO Republic Capability Check",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository?.repoRoot ?? "not a git repository"}`,
    report.deliberationID ? `Deliberation: ${report.deliberationID}` : undefined,
    `Result: ${report.passed ? "pass" : "fail"}`,
    `Failures: ${report.failures}`,
    `Warnings: ${report.warnings}`,
    "",
    "## Expected Hard Fields",
    "",
    `Dispatch: ${report.expected.dispatchID ?? "any"}`,
    `Source message: ${report.expected.sourceMessageID ?? "any"}`,
    `Author seat: ${report.expected.authorSeatID ?? "any"}`,
    `Target seat: ${report.expected.targetSeatID ?? "any"}`,
    `Message type: ${report.expected.messageType ?? "any"}`,
    `Required content: ${report.expected.contentTerms.length > 0 ? report.expected.contentTerms.join(", ") : "none"}`,
    `Require clean worktree: ${report.expected.cleanWorktree ? "yes" : "no"}`,
    `Require dispatched queue: ${report.expected.dispatchedQueue ? "yes" : "no"}`,
    `Allow indirect reference graph: ${report.expected.allowIndirect ? "yes" : "no"}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
    ...report.checks.map(formatCheck),
    "",
    "## Evidence",
    "",
    `Matching responses: ${report.matchingResponses.length}`,
    `Matching queue records: ${report.matchingQueueRecords.length}`,
    `Dirty files: ${report.dirtyFiles.length > 0 ? report.dirtyFiles.join(", ") : "none"}`,
  ].filter((line): line is string => typeof line === "string")

  return lines.join("\n")
}

export function collectCapabilityContentTerm(
  value: string,
  previous: string[],
): string[] {
  return [...previous, value]
}

export async function republicCapabilityCheck(options: RepublicCapabilityOptions = {}): Promise<number> {
  const report = buildRepublicCapabilityReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicCapabilityReport(report)

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

  return report.passed ? 0 : 1
}
