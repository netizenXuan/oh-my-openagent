import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import type { NativeGitRepository } from "./native-git"

export interface RepublicLedgerRecord {
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

export function sanitizeRepublicDeliberationID(deliberationID: string): string {
  const sanitized = deliberationID.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return sanitized || "deliberation"
}

export function getRepublicLedgerPath(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "ledger.jsonl")
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
