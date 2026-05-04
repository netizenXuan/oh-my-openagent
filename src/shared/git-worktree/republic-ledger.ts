import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { NativeGitRepository } from "./native-git"

export interface RepublicLedgerRecord {
  version?: number
  timestamp?: string
  repoRoot?: string
  deliberationID: string
  phase: string
  chamber?: string
  seatID?: string
  role?: string
  agent?: string
  model?: string
  sessionID?: string
  callID?: string
  promptHash?: string
  inputBriefHash?: string
  vote?: string
  confidence?: number
  relatedCommit?: string
  files?: string[]
  summary?: string
}

export interface RepublicVoteSummary {
  approve: number
  revise: number
  reject: number
  abstain: number
  other: number
}

export interface RepublicLedgerSummary {
  deliberationID?: string
  recordCount: number
  deliberationIDs: string[]
  phases: Record<string, number>
  chambers: Record<string, number>
  agents: Record<string, number>
  seats: string[]
  votes: RepublicVoteSummary
  averageConfidence: number | null
  files: string[]
  latestTimestamp?: string
  latestSummary?: string
  blocked: boolean
}

export function sanitizeRepublicDeliberationID(deliberationID: string): string {
  const sanitized = deliberationID.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return sanitized || "deliberation"
}

export function getRepublicLedgerPath(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "ledger.jsonl")
}

function incrementCounter(counter: Record<string, number>, key: string | undefined): void {
  if (!key) return
  counter[key] = (counter[key] ?? 0) + 1
}

function parseRepublicLedgerLine(line: string): RepublicLedgerRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<RepublicLedgerRecord>
    if (typeof parsed.deliberationID !== "string" || typeof parsed.phase !== "string") {
      return null
    }

    return parsed as RepublicLedgerRecord
  } catch {
    return null
  }
}

export function readRepublicLedgerRecords(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicLedgerRecord[] {
  const ledgerPath = getRepublicLedgerPath(repository)
  if (!existsSync(ledgerPath)) {
    return []
  }

  const sanitizedID = deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined
  return readFileSync(ledgerPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRepublicLedgerLine)
    .filter((record): record is RepublicLedgerRecord => record !== null)
    .filter((record) => !sanitizedID || sanitizeRepublicDeliberationID(record.deliberationID) === sanitizedID)
}

export function summarizeRepublicLedgerRecords(
  records: RepublicLedgerRecord[],
  deliberationID?: string,
): RepublicLedgerSummary {
  const phases: Record<string, number> = {}
  const chambers: Record<string, number> = {}
  const agents: Record<string, number> = {}
  const seats = new Set<string>()
  const deliberationIDs = new Set<string>()
  const files = new Set<string>()
  const votes: RepublicVoteSummary = {
    approve: 0,
    revise: 0,
    reject: 0,
    abstain: 0,
    other: 0,
  }
  let confidenceTotal = 0
  let confidenceCount = 0
  let latestTimestamp: string | undefined
  let latestSummary: string | undefined
  let blocked = false

  for (const record of records) {
    const sanitizedID = sanitizeRepublicDeliberationID(record.deliberationID)
    deliberationIDs.add(sanitizedID)
    incrementCounter(phases, record.phase)
    incrementCounter(chambers, record.chamber)
    incrementCounter(agents, record.agent)
    if (record.seatID) seats.add(record.seatID)
    for (const file of record.files ?? []) {
      files.add(file)
    }

    if (typeof record.confidence === "number" && Number.isFinite(record.confidence)) {
      confidenceTotal += record.confidence
      confidenceCount += 1
    }

    const normalizedVote = record.vote?.toLowerCase()
    if (normalizedVote === "approve") {
      votes.approve += 1
    } else if (normalizedVote === "revise") {
      votes.revise += 1
    } else if (normalizedVote === "reject") {
      votes.reject += 1
    } else if (normalizedVote === "abstain") {
      votes.abstain += 1
    } else if (normalizedVote) {
      votes.other += 1
    }

    if (normalizedVote === "reject" || record.summary?.toLowerCase().includes("blocker")) {
      blocked = true
    }

    if (record.timestamp && (!latestTimestamp || record.timestamp > latestTimestamp)) {
      latestTimestamp = record.timestamp
      latestSummary = record.summary
    }
  }

  return {
    deliberationID: deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined,
    recordCount: records.length,
    deliberationIDs: Array.from(deliberationIDs).sort(),
    phases,
    chambers,
    agents,
    seats: Array.from(seats).sort(),
    votes,
    averageConfidence: confidenceCount > 0 ? Number((confidenceTotal / confidenceCount).toFixed(3)) : null,
    files: Array.from(files).sort(),
    latestTimestamp,
    latestSummary,
    blocked,
  }
}

export function summarizeRepublicLedger(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicLedgerSummary {
  return summarizeRepublicLedgerRecords(readRepublicLedgerRecords(repository, deliberationID), deliberationID)
}

export function getRepublicDeliberationDir(
  repository: NativeGitRepository,
  deliberationID: string,
): string {
  return join(
    repository.gitCommonDir,
    "omo",
    "republic",
    "deliberations",
    sanitizeRepublicDeliberationID(deliberationID),
  )
}

export function appendRepublicLedgerRecord(
  repository: NativeGitRepository,
  record: RepublicLedgerRecord,
): string {
  const ledgerPath = getRepublicLedgerPath(repository)
  mkdirSync(dirname(ledgerPath), { recursive: true })
  appendFileSync(
    ledgerPath,
    JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      repoRoot: repository.repoRoot,
      ...record,
      deliberationID: sanitizeRepublicDeliberationID(record.deliberationID),
    }) + "\n",
    "utf-8",
  )
  return ledgerPath
}
