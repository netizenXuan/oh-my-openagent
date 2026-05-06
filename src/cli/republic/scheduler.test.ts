/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
  readRepublicSchedulerQueueRecords,
} from "../../shared/git-worktree"
import {
  buildRepublicSchedulerPlan,
  formatRepublicSchedulerPlan,
} from "./scheduler"

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
    "user.name=Republic Scheduler Test",
    "-c",
    "user.email=republic-scheduler@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

describe("republic scheduler cli", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-scheduler-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("reports no repository outside git", () => {
    const plan = buildRepublicSchedulerPlan({ directory })

    expect(plan.repository).toBeNull()
    expect(formatRepublicSchedulerPlan(plan)).toContain("Not inside a git repository")
  })

  test("writes wake prompts for queued dispatches without dirtying the worktree", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "dispatch-docs-seat-1",
      queueType: "seat-response",
      status: "queued",
      reason: "manager_unavailable",
      deliberationID: "order-status",
      phase: "collaboration",
      sourceMessageID: "question-1",
      sourceMessageType: "question",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      files: ["README.md"],
      summary: "Docs need to answer the API status shape question.",
    })

    const plan = buildRepublicSchedulerPlan({
      directory,
      deliberationId: "order-status",
      writePrompts: true,
    })
    const action = plan.actions[0]

    expect(plan.queuedCount).toBe(1)
    expect(action?.status).toBe("prompt-written")
    expect(action?.promptPath).toContain(join(".git", "omo", "republic", "scheduler", "prompts"))
    expect(existsSync(action!.promptPath!)).toBe(true)
    const prompt = readFileSync(action!.promptPath!, "utf-8")
    expect(prompt).toContain('persistent Republic seat "docs-seat"')
    expect(prompt).toContain('message_type="answer"')
    expect(readRepublicSchedulerQueueRecords(repository!, "order-status")).toHaveLength(1)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("ignores queued dispatches after the same dispatch id is dispatched", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "dispatch-docs-seat-1",
      queueType: "seat-response",
      status: "queued",
      reason: "manager_unavailable",
      deliberationID: "order-status",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      summary: "Docs need to answer.",
    })
    appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "dispatch-docs-seat-1",
      queueType: "seat-response",
      status: "dispatched",
      deliberationID: "order-status",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      runtimeAgent: "sisyphus",
      taskID: "external:dispatch-docs-seat-1",
      summary: "Docs were launched.",
    })

    const plan = buildRepublicSchedulerPlan({ directory, deliberationId: "order-status" })

    expect(plan.queuedCount).toBe(0)
    expect(plan.actions).toEqual([])
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
