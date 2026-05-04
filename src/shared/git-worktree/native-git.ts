import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { collectGitDiffStats } from "./collect-git-diff-stats"
import { formatFileChanges } from "./format-file-changes"

const GIT_TIMEOUT_MS = 5000

export interface NativeGitRepository {
  repoRoot: string
  gitCommonDir: string
}

export interface NativeGitStatus {
  repository: NativeGitRepository
  files: string[]
  dirty: boolean
  statusKey: string
}

export interface NativeGitAuditRecord {
  version?: number
  timestamp?: string
  repoRoot?: string
  sessionID?: string
  callID?: string
  tool: string
  agent?: string
  model?: string
  category?: string
  files: string[]
  summary?: string
}

export interface NativeGitAuditSummary {
  recordCount: number
  tools: Record<string, number>
  agents: Record<string, number>
  models: Record<string, number>
  categories: Record<string, number>
  sessions: Record<string, number>
  files: string[]
  latestTimestamp?: string
  latestSummary?: string
}

function runGit(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd()
}

function resolveGitCommonDir(directory: string, repoRoot: string): string {
  try {
    return runGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  } catch {
    const rawCommonDir = runGit(directory, ["rev-parse", "--git-common-dir"])
    return isAbsolute(rawCommonDir) ? rawCommonDir : resolve(directory, rawCommonDir)
  }
}

export function getNativeGitRepository(directory: string): NativeGitRepository | null {
  try {
    const repoRoot = runGit(directory, ["rev-parse", "--show-toplevel"])
    const gitCommonDir = resolveGitCommonDir(directory, repoRoot)
    return { repoRoot, gitCommonDir }
  } catch {
    return null
  }
}

export function parseNativeGitStatusPorcelainZ(output: string): string[] {
  if (!output) return []

  const entries = output.split("\0").filter(Boolean)
  const files: string[] = []

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue

    const scoredStatus = entry.match(/^([RC]\d{1,3}) (.+)$/)
    const status = scoredStatus ? scoredStatus[1] : entry.slice(0, 2)
    const filePath = scoredStatus ? scoredStatus[2] : entry.slice(3)
    if (filePath) {
      files.push(filePath)
    }

    if (status.includes("R") || status.includes("C")) {
      index += 1
    }
  }

  return files
}

function createNativeGitStatusKey(repository: NativeGitRepository, statusOutput: string, files: string[]): string {
  const hash = createHash("sha256")
  hash.update(statusOutput)

  try {
    hash.update(runGit(repository.repoRoot, ["diff", "--binary", "HEAD"]))
  } catch {
    // Status output and file fingerprints still give us a stable dirty-state key.
  }

  for (const filePath of files.slice().sort()) {
    hash.update("\0file:")
    hash.update(filePath)

    try {
      const absolutePath = join(repository.repoRoot, filePath)
      const stat = statSync(absolutePath)
      hash.update(`\0size:${stat.size}`)

      if (stat.isFile()) {
        hash.update("\0content:")
        hash.update(readFileSync(absolutePath))
      } else {
        hash.update("\0non-file")
      }
    } catch {
      hash.update("\0missing")
    }
  }

  return hash.digest("hex")
}

export function getNativeGitStatus(directory: string): NativeGitStatus | null {
  const repository = getNativeGitRepository(directory)
  if (!repository) return null

  try {
    const output = runGit(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    const files = parseNativeGitStatusPorcelainZ(output)
    return {
      repository,
      files,
      dirty: files.length > 0,
      statusKey: createNativeGitStatusKey(repository, output, files),
    }
  } catch {
    return null
  }
}

export function getNativeGitChangeSummary(directory: string): string {
  const stats = collectGitDiffStats(directory)
  return formatFileChanges(stats)
}

export function getNativeGitAuditPath(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "native-git", "audit.jsonl")
}

function parseNativeGitAuditLine(line: string): NativeGitAuditRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<NativeGitAuditRecord>
    if (typeof parsed.tool !== "string" || !Array.isArray(parsed.files)) {
      return null
    }

    return parsed as NativeGitAuditRecord
  } catch {
    return null
  }
}

function incrementCounter(counter: Record<string, number>, key: string | undefined): void {
  if (!key) return
  counter[key] = (counter[key] ?? 0) + 1
}

export function readNativeGitAuditRecords(repository: NativeGitRepository): NativeGitAuditRecord[] {
  const auditPath = getNativeGitAuditPath(repository)
  if (!existsSync(auditPath)) {
    return []
  }

  return readFileSync(auditPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseNativeGitAuditLine)
    .filter((record): record is NativeGitAuditRecord => record !== null)
}

export function summarizeNativeGitAuditRecords(records: NativeGitAuditRecord[]): NativeGitAuditSummary {
  const tools: Record<string, number> = {}
  const agents: Record<string, number> = {}
  const models: Record<string, number> = {}
  const categories: Record<string, number> = {}
  const sessions: Record<string, number> = {}
  const files = new Set<string>()
  let latestTimestamp: string | undefined
  let latestSummary: string | undefined

  for (const record of records) {
    incrementCounter(tools, record.tool)
    incrementCounter(agents, record.agent)
    incrementCounter(models, record.model)
    incrementCounter(categories, record.category)
    incrementCounter(sessions, record.sessionID)
    for (const file of record.files) {
      files.add(file)
    }

    if (record.timestamp && (!latestTimestamp || record.timestamp > latestTimestamp)) {
      latestTimestamp = record.timestamp
      latestSummary = record.summary
    }
  }

  return {
    recordCount: records.length,
    tools,
    agents,
    models,
    categories,
    sessions,
    files: Array.from(files).sort(),
    latestTimestamp,
    latestSummary,
  }
}

export function summarizeNativeGitAudit(repository: NativeGitRepository): NativeGitAuditSummary {
  return summarizeNativeGitAuditRecords(readNativeGitAuditRecords(repository))
}

export function appendNativeGitAuditRecord(
  repository: NativeGitRepository,
  record: NativeGitAuditRecord,
): string {
  const auditPath = getNativeGitAuditPath(repository)
  mkdirSync(dirname(auditPath), { recursive: true })
  appendFileSync(
    auditPath,
    JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      repoRoot: repository.repoRoot,
      ...record,
    }) + "\n",
    "utf-8",
  )
  return auditPath
}
