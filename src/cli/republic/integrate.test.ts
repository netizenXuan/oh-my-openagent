/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository, initializeRepublicTeam, readRepublicCommonsMessages } from "../../shared/git-worktree"
import { buildRepublicIntegrationReport, republicIntegrate } from "./integrate"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd()
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ["add", "."])
  git(cwd, ["commit", "--no-gpg-sign", "-m", message])
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

describe("republic integrate", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-integrate-"))
    git(directory, ["init"])
    git(directory, ["config", "user.name", "Republic Integrate Test"])
    git(directory, ["config", "user.email", "republic-integrate@example.test"])
    writeFileSync(join(directory, "README.md"), "base\n", "utf-8")
    commitAll(directory, "init")
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("plans integration sources from the team manifest without dirtying the worktree", () => {
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 2,
        defaultRuntimeAgent: "general",
        seats: [
          { seatID: "api-seat", role: "executor", workgroupID: "api-workgroup" },
          { seatID: "test-seat", role: "executor", workgroupID: "test-workgroup" },
        ],
      },
    })
    git(directory, ["switch", "-c", "republic/order-system/api-workgroup"])
    writeFileSync(join(directory, "api.txt"), "api\n", "utf-8")
    commitAll(directory, "api work")
    git(directory, ["switch", "-"])
    git(directory, ["switch", "-c", "republic/order-system/test-workgroup"])
    writeFileSync(join(directory, "test.txt"), "test\n", "utf-8")
    commitAll(directory, "test work")
    git(directory, ["switch", "-"])

    const report = buildRepublicIntegrationReport({
      directory,
      deliberationId: "order system",
    })

    expect(report.applied).toBe(false)
    expect(report.actions.map((action) => action.source)).toEqual([
      "republic/order-system/api-workgroup",
      "republic/order-system/test-workgroup",
    ])
    expect(report.actions.every((action) => action.status === "planned")).toBe(true)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("applies an integration branch and leaves the caller branch restored", async () => {
    const rootBranch = git(directory, ["branch", "--show-current"])
    git(directory, ["switch", "-c", "republic/order-system/api-workgroup"])
    writeFileSync(join(directory, "api.txt"), "api\n", "utf-8")
    commitAll(directory, "api work")
    git(directory, ["switch", rootBranch])
    git(directory, ["switch", "-c", "republic/order-system/test-workgroup"])
    writeFileSync(join(directory, "test.txt"), "test\n", "utf-8")
    commitAll(directory, "test work")
    git(directory, ["switch", rootBranch])

    const exitCode = await silenceConsole(() => republicIntegrate({
      directory,
      deliberationId: "order system",
      sourceBranch: [
        "republic/order-system/api-workgroup",
        "republic/order-system/test-workgroup",
      ],
      checkCommand: ["git status --porcelain"],
      apply: true,
    }))

    expect(exitCode).toBe(0)
    expect(git(directory, ["branch", "--show-current"])).toBe(rootBranch)
    expect(git(directory, ["show", "republic/order-system/integration:api.txt"])).toBe("api")
    expect(git(directory, ["show", "republic/order-system/integration:test.txt"])).toBe("test")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("publishes a supervisor intervention when an integration check fails", () => {
    const repository = getNativeGitRepository(directory)!

    const report = buildRepublicIntegrationReport({
      directory,
      deliberationId: "order system",
      sourceBranch: [],
      checkCommand: ["git not-a-command"],
      apply: true,
    })
    const messages = readRepublicCommonsMessages(repository, "order-system")

    expect(report.actions[0]?.status).toBe("failed")
    expect(messages[0]?.messageType).toBe("intervention")
    expect(messages[0]?.authorSeatID).toBe("republic-integrator")
    expect(messages[0]?.content).toContain("Integration branch republic/order-system/integration")
    expect(readFileSync(join(repository.gitCommonDir, "omo", "republic", "commons.jsonl"), "utf-8")).toContain("git not-a-command")
  })
})
