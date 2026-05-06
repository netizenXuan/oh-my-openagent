import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import {
  getNativeGitRepository,
  getNativeGitStatus,
  readRepublicTeamManifest,
  sanitizeRepublicDeliberationID,
  type NativeGitRepository,
} from "../../shared/git-worktree"

export type RepublicWorktreeActionStatus = "planned" | "created" | "exists" | "failed" | "skipped"

export interface RepublicWorktreeAction {
  workgroupID: string
  branch: string
  path: string
  status: RepublicWorktreeActionStatus
  reason?: string
}

export interface RepublicWorktreePlan {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID: string
  baseRef: string
  cleanRequired: boolean
  created: boolean
  actions: RepublicWorktreeAction[]
}

export interface RepublicWorktreeOptions {
  directory?: string
  deliberationId?: string
  baseRef?: string
  root?: string
  create?: boolean
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

function defaultWorktreeRoot(repository: NativeGitRepository): string {
  return join(dirname(repository.repoRoot), `${basename(repository.repoRoot)}-republic-worktrees`)
}

function listWorkgroups(repository: NativeGitRepository): string[] {
  const manifest = readRepublicTeamManifest(repository)
  const workgroups = new Set<string>()
  for (const seat of manifest?.seats ?? []) {
    if (seat.workgroupID) {
      workgroups.add(sanitizeRepublicDeliberationID(seat.workgroupID))
    }
  }
  return Array.from(workgroups).sort((left, right) => left.localeCompare(right))
}

function createBranchName(deliberationID: string, workgroupID: string): string {
  return `republic/${sanitizeRepublicDeliberationID(deliberationID)}/${sanitizeRepublicDeliberationID(workgroupID)}`
}

export function buildRepublicWorktreePlan(options: RepublicWorktreeOptions = {}): RepublicWorktreePlan {
  const directory = options.directory ?? process.cwd()
  const repository = getNativeGitRepository(directory)
  const deliberationID = sanitizeRepublicDeliberationID(options.deliberationId ?? "republic")
  const baseRef = options.baseRef ?? "HEAD"
  const create = options.create ?? false
  const cleanRequired = !(options.allowDirty ?? false)

  if (!repository) {
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      deliberationID,
      baseRef,
      cleanRequired,
      created: false,
      actions: [],
    }
  }

  const status = getNativeGitStatus(repository.repoRoot)
  const root = resolve(options.root ?? defaultWorktreeRoot(repository), deliberationID)
  const workgroups = listWorkgroups(repository)
  const actions: RepublicWorktreeAction[] = []
  const dirtyBlocked = create && cleanRequired && (status?.dirty ?? false)

  for (const workgroupID of workgroups) {
    const branch = createBranchName(deliberationID, workgroupID)
    const path = join(root, workgroupID)
    if (dirtyBlocked) {
      actions.push({
        workgroupID,
        branch,
        path,
        status: "skipped",
        reason: "root_worktree_dirty",
      })
      continue
    }

    if (!create) {
      actions.push({ workgroupID, branch, path, status: "planned" })
      continue
    }

    if (existsSync(path)) {
      actions.push({
        workgroupID,
        branch,
        path,
        status: "exists",
        reason: "worktree_path_exists",
      })
      continue
    }

    try {
      mkdirSync(dirname(path), { recursive: true })
      runGit(repository.repoRoot, ["worktree", "add", "-b", branch, path, baseRef])
      actions.push({ workgroupID, branch, path, status: "created" })
    } catch (error) {
      actions.push({
        workgroupID,
        branch,
        path,
        status: "failed",
        reason: error instanceof Error ? error.message : "git_worktree_add_failed",
      })
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    baseRef,
    cleanRequired,
    created: create,
    actions,
  }
}

export function formatRepublicWorktreePlan(plan: RepublicWorktreePlan): string {
  if (!plan.repository) {
    return "OMO Republic Worktrees\n\nNot inside a git repository. No worktree plan can be generated."
  }

  const lines = [
    "# OMO Republic Worktrees",
    "",
    `Generated: ${plan.generatedAt}`,
    `Repository: ${plan.repository.repoRoot}`,
    `Deliberation: ${plan.deliberationID}`,
    `Base ref: ${plan.baseRef}`,
    `Clean required: ${plan.cleanRequired ? "yes" : "no"}`,
    `Mode: ${plan.created ? "create" : "plan"}`,
    "",
    "| Workgroup | Branch | Path | Status | Reason |",
    "| --- | --- | --- | --- | --- |",
  ]

  if (plan.actions.length === 0) {
    lines.push("| none | none | none | skipped | no workgroups found in Republic team manifest |")
  } else {
    for (const action of plan.actions) {
      lines.push(`| ${action.workgroupID} | ${action.branch} | ${action.path} | ${action.status} | ${action.reason ?? ""} |`)
    }
  }

  return lines.join("\n")
}

export async function republicWorktrees(options: RepublicWorktreeOptions = {}): Promise<number> {
  const plan = buildRepublicWorktreePlan(options)
  const content = options.json ? JSON.stringify(plan, null, 2) : formatRepublicWorktreePlan(plan)

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

  if (!plan.repository) return 1
  return plan.actions.some((action) => action.status === "failed" || action.status === "skipped") ? 1 : 0
}
