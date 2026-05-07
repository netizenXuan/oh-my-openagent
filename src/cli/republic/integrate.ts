import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  appendRepublicCommonsMessage,
  getNativeGitRepository,
  getNativeGitStatus,
  readRepublicTeamManifest,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
} from "../../shared/git-worktree"

export type RepublicIntegrationActionStatus = "planned" | "merged" | "checked" | "failed" | "skipped"

export interface RepublicIntegrationAction {
  source: string
  status: RepublicIntegrationActionStatus
  reason?: string
  command?: string
  exitCode?: number | null
}

export interface RepublicIntegrationReport {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID: string
  integrationBranch: string
  baseRef: string
  applied: boolean
  cleanRequired: boolean
  actions: RepublicIntegrationAction[]
}

export interface RepublicIntegrationOptions {
  directory?: string
  deliberationId?: string
  integrationBranch?: string
  baseRef?: string
  sourceBranch?: string[]
  checkCommand?: string[]
  apply?: boolean
  allowDirty?: boolean
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

function branchExists(directory: string, branch: string): boolean {
  try {
    runGit(directory, ["rev-parse", "--verify", "--quiet", branch])
    return true
  } catch {
    return false
  }
}

function currentBranch(directory: string): string {
  try {
    return runGit(directory, ["branch", "--show-current"])
  } catch {
    return ""
  }
}

function defaultIntegrationBranch(deliberationID: string): string {
  return `republic/${sanitizeRepublicDeliberationID(deliberationID)}/integration`
}

function workgroupBranch(deliberationID: string, workgroupID: string): string {
  return `republic/${sanitizeRepublicDeliberationID(deliberationID)}/${sanitizeRepublicDeliberationID(workgroupID)}`
}

function sourceBranches(repository: NativeGitRepository, deliberationID: string, explicit?: string[]): string[] {
  if (explicit && explicit.length > 0) {
    return explicit
  }

  const manifest = readRepublicTeamManifest(repository)
  const workgroups = new Set<string>()
  for (const seat of manifest?.seats ?? []) {
    if (seat.workgroupID) {
      workgroups.add(sanitizeRepublicDeliberationID(seat.workgroupID))
    }
  }
  return Array.from(workgroups)
    .sort((left, right) => left.localeCompare(right))
    .map((workgroupID) => workgroupBranch(deliberationID, workgroupID))
}

function publishIntegrationIntervention(
  repository: NativeGitRepository,
  report: RepublicIntegrationReport,
  content: string,
): void {
  appendRepublicCommonsMessage(repository, {
    deliberationID: report.deliberationID,
    channel: "integration",
    phase: "execution",
    authorSeatID: "republic-integrator",
    targetSeatID: "republic-supervisor",
    messageType: "intervention",
    status: "blocked",
    content,
  })
}

function safeAbortMerge(directory: string): void {
  try {
    runGit(directory, ["merge", "--abort"])
  } catch {
    // No merge in progress or abort failed; the failure is already reported.
  }
}

function ensureIntegrationBranch(directory: string, integrationBranch: string, baseRef: string): void {
  if (branchExists(directory, integrationBranch)) {
    runGit(directory, ["switch", integrationBranch])
  } else {
    runGit(directory, ["switch", "-c", integrationBranch, baseRef])
  }
}

function executeCheckCommand(directory: string, command: string): {
  status: "checked" | "failed"
  exitCode: number | null
} {
  try {
    execFileSync(command, {
      cwd: directory,
      encoding: "utf-8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return { status: "checked", exitCode: 0 }
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : null
    return { status: "failed", exitCode: Number.isFinite(status) ? status : null }
  }
}

export function buildRepublicIntegrationReport(options: RepublicIntegrationOptions = {}): RepublicIntegrationReport {
  const directory = resolve(options.directory ?? process.cwd())
  const repository = getNativeGitRepository(directory)
  const deliberationID = sanitizeRepublicDeliberationID(options.deliberationId ?? "republic")
  const integrationBranch = options.integrationBranch ?? defaultIntegrationBranch(deliberationID)
  const baseRef = options.baseRef ?? "HEAD"
  const apply = options.apply ?? false
  const cleanRequired = !(options.allowDirty ?? false)

  if (!repository) {
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      deliberationID,
      integrationBranch,
      baseRef,
      applied: false,
      cleanRequired,
      actions: [],
    }
  }

  const sources = sourceBranches(repository, deliberationID, options.sourceBranch)
  const actions: RepublicIntegrationAction[] = []
  if (!apply) {
    for (const source of sources) {
      actions.push({
        source,
        status: branchExists(repository.repoRoot, source) ? "planned" : "skipped",
        reason: branchExists(repository.repoRoot, source) ? undefined : "source_branch_missing",
      })
    }
    for (const command of options.checkCommand ?? []) {
      actions.push({ source: command, status: "planned", reason: "check_command" })
    }
    return {
      generatedAt: new Date().toISOString(),
      repository,
      deliberationID,
      integrationBranch,
      baseRef,
      applied: false,
      cleanRequired,
      actions,
    }
  }

  const status = getNativeGitStatus(repository.repoRoot)
  if (cleanRequired && status?.dirty) {
    const report = {
      generatedAt: new Date().toISOString(),
      repository,
      deliberationID,
      integrationBranch,
      baseRef,
      applied: true,
      cleanRequired,
      actions: sources.map((source) => ({
        source,
        status: "skipped" as const,
        reason: "root_worktree_dirty",
      })),
    }
    publishIntegrationIntervention(repository, report, "Integration was skipped because the root worktree is dirty.")
    return report
  }

  const originalBranch = currentBranch(repository.repoRoot)
  try {
    ensureIntegrationBranch(repository.repoRoot, integrationBranch, baseRef)
    for (const source of sources) {
      if (!branchExists(repository.repoRoot, source)) {
        actions.push({ source, status: "skipped", reason: "source_branch_missing" })
        continue
      }

      try {
        runGit(repository.repoRoot, ["merge", "--no-ff", "--no-edit", source])
        actions.push({ source, status: "merged" })
      } catch (error) {
        safeAbortMerge(repository.repoRoot)
        actions.push({
          source,
          status: "failed",
          reason: error instanceof Error ? error.message : "git_merge_failed",
        })
      }
    }

    for (const command of options.checkCommand ?? []) {
      const result = executeCheckCommand(repository.repoRoot, command)
      actions.push({
        source: command,
        status: result.status,
        reason: result.status === "checked" ? "check_command_passed" : "check_command_failed",
        command,
        exitCode: result.exitCode,
      })
    }
  } finally {
    if (originalBranch) {
      try {
        runGit(repository.repoRoot, ["switch", originalBranch])
      } catch {
        // Leave the integration branch checked out if the original branch cannot be restored.
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    integrationBranch,
    baseRef,
    applied: true,
    cleanRequired,
    actions,
  }
  const failures = actions.filter((action) => action.status === "failed")
  if (failures.length > 0) {
    publishIntegrationIntervention(
      repository,
      report,
      `Integration branch ${integrationBranch} needs supervisor attention: ${failures.map((action) => action.source).join(", ")}.`,
    )
  }
  return report
}

export function formatRepublicIntegrationReport(report: RepublicIntegrationReport): string {
  if (!report.repository) {
    return "OMO Republic Integration\n\nNot inside a git repository. No integration branch can be planned."
  }

  const lines = [
    "# OMO Republic Integration",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository.repoRoot}`,
    `Deliberation: ${report.deliberationID}`,
    `Integration branch: ${report.integrationBranch}`,
    `Base ref: ${report.baseRef}`,
    `Mode: ${report.applied ? "apply" : "plan"}`,
    `Clean required: ${report.cleanRequired ? "yes" : "no"}`,
    "",
    "| Source | Status | Reason |",
    "| --- | --- | --- |",
  ]

  if (report.actions.length === 0) {
    lines.push("| none | skipped | no source branches or checks were selected |")
  } else {
    for (const action of report.actions) {
      lines.push(`| ${action.source} | ${action.status} | ${action.reason ?? ""} |`)
    }
  }
  return lines.join("\n")
}

export async function republicIntegrate(options: RepublicIntegrationOptions = {}): Promise<number> {
  const report = buildRepublicIntegrationReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicIntegrationReport(report)

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
  return report.actions.some((action) => action.status === "failed" || (report.applied && action.status === "skipped")) ? 1 : 0
}
