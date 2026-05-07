/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository, initializeRepublicTeam } from "../../shared/git-worktree"
import { buildRepublicWorktreePlan, formatRepublicWorktreePlan, republicWorktrees } from "./worktrees"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd()
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."])
  git(cwd, [
    "-c",
    "user.name=Republic Worktree Test",
    "-c",
    "user.email=republic-worktree@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

async function silenceConsole<T>(callback: () => Promise<T>): Promise<T> {
  const originalLog = console.log
  console.log = () => {}
  try {
    return await callback()
  } finally {
    console.log = originalLog
  }
}

describe("republic worktrees", () => {
  let root: string
  let directory: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omo-republic-worktrees-"))
    directory = join(root, "repo")
    git(root, ["init", directory])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("plans one worktree per manifest workgroup", () => {
    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    initializeRepublicTeam(repository!, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          { seatID: "api-seat", role: "executor", workgroupID: "api-workgroup" },
          { seatID: "api-review-seat", role: "reviewer", workgroupID: "api-workgroup" },
          { seatID: "docs-seat", role: "executor", workgroupID: "docs-workgroup" },
        ],
      },
    })

    const plan = buildRepublicWorktreePlan({
      directory,
      deliberationId: "order system",
      root: join(root, "worktrees"),
    })
    const formatted = formatRepublicWorktreePlan(plan)

    expect(plan.actions.map((action) => action.workgroupID)).toEqual(["api-workgroup", "docs-workgroup"])
    expect(plan.actions[0]?.branch).toBe("republic/order-system/api-workgroup")
    expect(plan.actions.every((action) => action.status === "planned")).toBe(true)
    expect(formatted).toContain("api-workgroup")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("creates isolated git worktrees when requested", async () => {
    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    initializeRepublicTeam(repository!, {
      manifest: {
        teamModel: "squad",
        seatAllocation: "auto",
        maxParallelSeats: 2,
        defaultRuntimeAgent: "general",
        seats: [
          { seatID: "api-seat", role: "executor", workgroupID: "api-workgroup" },
        ],
      },
    })

    const worktreeRoot = join(root, "worktrees")
    const exitCode = await silenceConsole(() => republicWorktrees({
      directory,
      deliberationId: "order system",
      root: worktreeRoot,
      create: true,
    }))
    const plan = buildRepublicWorktreePlan({
      directory,
      deliberationId: "order system",
      root: worktreeRoot,
    })

    expect(exitCode).toBe(0)
    expect(existsSync(join(worktreeRoot, "order-system", "api-workgroup", "README.md"))).toBe(true)
    expect(plan.actions[0]?.status).toBe("planned")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("skips creation when the root worktree is dirty", async () => {
    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    initializeRepublicTeam(repository!, {
      manifest: {
        teamModel: "squad",
        seatAllocation: "auto",
        maxParallelSeats: 2,
        defaultRuntimeAgent: "general",
        seats: [
          { seatID: "api-seat", role: "executor", workgroupID: "api-workgroup" },
        ],
      },
    })
    writeFileSync(join(directory, "dirty.txt"), "dirty\n", "utf-8")

    const plan = buildRepublicWorktreePlan({
      directory,
      deliberationId: "order system",
      root: join(root, "worktrees"),
      create: true,
    })

    expect(plan.actions[0]?.status).toBe("skipped")
    expect(plan.actions[0]?.reason).toBe("root_worktree_dirty")
    expect(await silenceConsole(() => republicWorktrees({
      directory,
      deliberationId: "order system",
      root: join(root, "worktrees"),
      create: true,
    }))).toBe(1)
  })
})
