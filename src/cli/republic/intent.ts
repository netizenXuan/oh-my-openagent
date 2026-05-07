import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  appendRepublicCommonsMessage,
  getNativeGitRepository,
  parseGitDiffNumstat,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
} from "../../shared/git-worktree"

export interface RepublicIntentReport {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID: string
  seatID: string
  messageID?: string
  stagedFiles: string[]
  inserted: number
  deleted: number
  published: boolean
  reason?: string
}

export interface RepublicIntentOptions {
  directory?: string
  deliberationId?: string
  seatId?: string
  targetSeatId?: string
  workgroupId?: string
  module?: string
  message?: string
  output?: string
  json?: boolean
}

function runGit(directory: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd()
}

function stagedDiffStats(repository: NativeGitRepository): {
  files: string[]
  inserted: number
  deleted: number
  summary: string
} {
  const numstat = runGit(repository.repoRoot, ["diff", "--cached", "--numstat"])
  const stats = parseGitDiffNumstat(numstat, new Map())
  const files = stats.map((stat) => stat.path)
  const inserted = stats.reduce((sum, stat) => sum + stat.added, 0)
  const deleted = stats.reduce((sum, stat) => sum + stat.removed, 0)
  const summary = files.length === 0
    ? "No staged file changes."
    : [
      `Staged files: ${files.join(", ")}`,
      `Inserted: ${inserted}`,
      `Deleted: ${deleted}`,
    ].join("\n")
  return { files, inserted, deleted, summary }
}

export function buildRepublicIntentReport(options: RepublicIntentOptions = {}): RepublicIntentReport {
  const directory = options.directory ?? process.cwd()
  const repository = getNativeGitRepository(directory)
  const deliberationID = sanitizeRepublicDeliberationID(options.deliberationId ?? "staged-intent")
  const seatID = sanitizeRepublicDeliberationID(options.seatId ?? "staged-intent-seat")

  if (!repository) {
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      deliberationID,
      seatID,
      stagedFiles: [],
      inserted: 0,
      deleted: 0,
      published: false,
      reason: "not_git_repository",
    }
  }

  const staged = stagedDiffStats(repository)
  if (staged.files.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      repository,
      deliberationID,
      seatID,
      stagedFiles: [],
      inserted: 0,
      deleted: 0,
      published: false,
      reason: "no_staged_changes",
    }
  }

  const messageID = `${deliberationID}-${seatID}-intent-${Date.now()}`
  appendRepublicCommonsMessage(repository, {
    messageID,
    deliberationID,
    channel: "intent",
    phase: "staged-intent",
    authorSeatID: seatID,
    targetSeatID: options.targetSeatId ? sanitizeRepublicDeliberationID(options.targetSeatId) : undefined,
    workgroupID: options.workgroupId ? sanitizeRepublicDeliberationID(options.workgroupId) : undefined,
    module: options.module,
    messageType: "proposal",
    files: staged.files,
    content: [
      options.message ?? "Staged intent proposal for review.",
      "",
      staged.summary,
    ].join("\n"),
  })

  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    seatID,
    messageID,
    stagedFiles: staged.files,
    inserted: staged.inserted,
    deleted: staged.deleted,
    published: true,
  }
}

export function formatRepublicIntentReport(report: RepublicIntentReport): string {
  return [
    "# OMO Republic Staged Intent",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository?.repoRoot ?? "not a git repository"}`,
    `Deliberation: ${report.deliberationID}`,
    `Seat: ${report.seatID}`,
    `Published: ${report.published ? "yes" : "no"}`,
    report.messageID ? `Message: ${report.messageID}` : undefined,
    report.reason ? `Reason: ${report.reason}` : undefined,
    `Files: ${report.stagedFiles.length > 0 ? report.stagedFiles.join(", ") : "none"}`,
    `Inserted: ${report.inserted}`,
    `Deleted: ${report.deleted}`,
  ].filter((line): line is string => typeof line === "string").join("\n")
}

export async function republicIntent(options: RepublicIntentOptions = {}): Promise<number> {
  const report = buildRepublicIntentReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicIntentReport(report)

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

  return report.published ? 0 : 1
}
