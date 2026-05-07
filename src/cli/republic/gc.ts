import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import {
  appendRepublicCommonsMessage,
  getNativeGitRepository,
  getRepublicCommonsPath,
  getRepublicLedgerPath,
  getRepublicSchedulerQueuePath,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
} from "../../shared/git-worktree"

export interface RepublicGCFileResult {
  name: "commons" | "ledger" | "scheduler"
  path: string
  archivePath?: string
  originalRecords: number
  selectedRecords: number
  retainedRecords: number
}

export interface RepublicGCReport {
  generatedAt: string
  repository: NativeGitRepository | null
  applied: boolean
  archiveDir?: string
  deliberationID?: string
  seatIDs: string[]
  messageTypes: string[]
  before?: string
  keepLast: number
  reason: string
  files: RepublicGCFileResult[]
}

export interface RepublicGCOptions {
  directory?: string
  deliberationId?: string
  seatId?: string[]
  messageType?: string[]
  before?: string
  keepLast?: number
  apply?: boolean
  reason?: string
  output?: string
  json?: boolean
}

interface JSONLRecord {
  raw: string
  value: Record<string, unknown> | null
}

function republicArchiveDir(repository: NativeGitRepository, timestamp: string): string {
  return join(repository.gitCommonDir, "omo", "republic", "archive", `${timestamp.replace(/[:.]/g, "-")}-gc`)
}

function readJSONL(path: string): JSONLRecord[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        return { raw: line, value }
      } catch {
        return { raw: line, value: null }
      }
    })
}

function writeJSONL(path: string, records: JSONLRecord[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, records.map((record) => record.raw).join("\n") + (records.length > 0 ? "\n" : ""), "utf-8")
}

function normalizeList(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean)
}

function recordSeat(record: Record<string, unknown>, fileName: RepublicGCFileResult["name"]): string[] {
  if (fileName === "commons") {
    return [record.authorSeatID, record.targetSeatID].filter((value): value is string => typeof value === "string")
  }
  if (fileName === "ledger") {
    return [record.seatID, record.supervisorSeatID].filter((value): value is string => typeof value === "string")
  }
  return [record.targetSeatID, record.requestedAgent, record.runtimeAgent].filter((value): value is string => typeof value === "string")
}

function recordMatches(
  record: JSONLRecord,
  fileName: RepublicGCFileResult["name"],
  options: {
    deliberationID?: string
    seatIDs: string[]
    messageTypes: string[]
    before?: string
  },
): boolean {
  const value = record.value
  if (!value) return false

  if (options.deliberationID && sanitizeRepublicDeliberationID(String(value.deliberationID ?? "")) !== options.deliberationID) {
    return false
  }
  if (options.seatIDs.length > 0) {
    const seats = recordSeat(value, fileName).map(sanitizeRepublicDeliberationID)
    if (!options.seatIDs.some((seat) => seats.includes(seat))) {
      return false
    }
  }
  if (options.messageTypes.length > 0) {
    const type = fileName === "scheduler" ? String(value.status ?? "") : String(value.messageType ?? value.status ?? "")
    if (!options.messageTypes.includes(type)) {
      return false
    }
  }
  if (options.before) {
    const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN
    const before = Date.parse(options.before)
    if (Number.isNaN(timestamp) || Number.isNaN(before) || timestamp >= before) {
      return false
    }
  }
  return true
}

function selectedIndexes(
  records: JSONLRecord[],
  fileName: RepublicGCFileResult["name"],
  options: {
    deliberationID?: string
    seatIDs: string[]
    messageTypes: string[]
    before?: string
    keepLast: number
  },
): Set<number> {
  const matches = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => recordMatches(record, fileName, options))
  const removable = options.keepLast > 0 ? matches.slice(0, Math.max(0, matches.length - options.keepLast)) : matches
  return new Set(removable.map(({ index }) => index))
}

function processFile(
  repository: NativeGitRepository,
  archiveDir: string | undefined,
  fileName: RepublicGCFileResult["name"],
  path: string,
  options: {
    apply: boolean
    deliberationID?: string
    seatIDs: string[]
    messageTypes: string[]
    before?: string
    keepLast: number
  },
): RepublicGCFileResult {
  const records = readJSONL(path)
  const selected = selectedIndexes(records, fileName, options)
  const retained = records.filter((_, index) => !selected.has(index))
  let archivePath: string | undefined

  if (options.apply && archiveDir && existsSync(path)) {
    mkdirSync(archiveDir, { recursive: true })
    archivePath = join(archiveDir, basename(path))
    writeFileSync(archivePath, readFileSync(path, "utf-8"), "utf-8")
    writeJSONL(path, retained)
  }

  return {
    name: fileName,
    path,
    archivePath,
    originalRecords: records.length,
    selectedRecords: selected.size,
    retainedRecords: retained.length,
  }
}

export function buildRepublicGCReport(options: RepublicGCOptions = {}): RepublicGCReport {
  const directory = resolve(options.directory ?? process.cwd())
  const repository = getNativeGitRepository(directory)
  const deliberationID = options.deliberationId ? sanitizeRepublicDeliberationID(options.deliberationId) : undefined
  const seatIDs = normalizeList(options.seatId).map(sanitizeRepublicDeliberationID)
  const messageTypes = normalizeList(options.messageType)
  const keepLast = Math.max(0, options.keepLast ?? 0)
  const apply = options.apply ?? false
  const reason = options.reason ?? "Republic GC removed noisy or stale active records after archiving originals."
  const timestamp = new Date().toISOString()

  if (!repository) {
    return {
      generatedAt: timestamp,
      repository: null,
      applied: false,
      deliberationID,
      seatIDs,
      messageTypes,
      before: options.before,
      keepLast,
      reason,
      files: [],
    }
  }

  const archiveDir = apply ? republicArchiveDir(repository, timestamp) : undefined
  const commonOptions = {
    apply,
    deliberationID,
    seatIDs,
    messageTypes,
    before: options.before,
    keepLast,
  }
  const files = [
    processFile(repository, archiveDir, "commons", getRepublicCommonsPath(repository), commonOptions),
    processFile(repository, archiveDir, "ledger", getRepublicLedgerPath(repository), commonOptions),
    processFile(repository, archiveDir, "scheduler", getRepublicSchedulerQueuePath(repository), commonOptions),
  ]

  const report: RepublicGCReport = {
    generatedAt: timestamp,
    repository,
    applied: apply,
    archiveDir,
    deliberationID,
    seatIDs,
    messageTypes,
    before: options.before,
    keepLast,
    reason,
    files,
  }

  if (apply) {
    if (archiveDir) {
      writeFileSync(join(archiveDir, "gc-report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8")
    }
    appendRepublicCommonsMessage(repository, {
      deliberationID: deliberationID ?? "republic",
      channel: "governance",
      phase: "review",
      authorSeatID: "republic-supervisor",
      messageType: "intervention",
      status: "gc-applied",
      content: `${reason} Archive: ${archiveDir ?? "none"}. Removed ${files.reduce((total, file) => total + file.selectedRecords, 0)} active record(s).`,
    })
  }

  return report
}

export function formatRepublicGCReport(report: RepublicGCReport): string {
  if (!report.repository) {
    return "OMO Republic GC\n\nNot inside a git repository. No Republic records can be compacted."
  }

  const lines = [
    "# OMO Republic GC",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository.repoRoot}`,
    `Mode: ${report.applied ? "apply" : "plan"}`,
    report.archiveDir ? `Archive: ${report.archiveDir}` : undefined,
    report.deliberationID ? `Deliberation: ${report.deliberationID}` : undefined,
    report.seatIDs.length > 0 ? `Seats: ${report.seatIDs.join(", ")}` : undefined,
    report.messageTypes.length > 0 ? `Types/statuses: ${report.messageTypes.join(", ")}` : undefined,
    report.before ? `Before: ${report.before}` : undefined,
    `Keep last matching records: ${report.keepLast}`,
    `Reason: ${report.reason}`,
    "",
    "| File | Original | Selected | Retained | Archive |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.files.map((file) => `| ${file.name} | ${file.originalRecords} | ${file.selectedRecords} | ${file.retainedRecords} | ${file.archivePath ?? ""} |`),
  ]
  return lines.filter((line): line is string => typeof line === "string").join("\n")
}

export async function republicGC(options: RepublicGCOptions = {}): Promise<number> {
  const report = buildRepublicGCReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicGCReport(report)

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
  return 0
}
