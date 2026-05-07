/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
  getRepublicSchedulerQueuePath,
  readRepublicCommonsMessages,
  readRepublicSchedulerQueueRecords,
} from "../../shared/git-worktree"
import { buildRepublicEscalationReport, republicEscalate } from "./escalate"

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
    "user.name=Republic Escalate Test",
    "-c",
    "user.email=republic-escalate@example.test",
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

describe("republic escalate", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-escalate-"))
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("plans failed-burst escalations without modifying the queue", () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicSchedulerQueueRecord(repository, {
      dispatchID: "docs-fail-1",
      queueType: "seat-response",
      status: "failed",
      deliberationID: "order-system",
      sourceMessageID: "question-1",
      targetSeatID: "docs-seat",
      requestedAgent: "ling",
      summary: "first weak-model failure",
    })
    appendRepublicSchedulerQueueRecord(repository, {
      dispatchID: "docs-fail-2",
      queueType: "seat-response",
      status: "failed",
      deliberationID: "order-system",
      sourceMessageID: "question-1",
      targetSeatID: "docs-seat",
      requestedAgent: "ling",
      summary: "second weak-model failure",
    })
    const before = readFileSync(getRepublicSchedulerQueuePath(repository), "utf-8")

    const report = buildRepublicEscalationReport({
      directory,
      deliberationId: "order-system",
      maxFailedPerSource: 1,
      escalationAgent: "hephaestus",
    })
    const after = readFileSync(getRepublicSchedulerQueuePath(repository), "utf-8")

    expect(report.actions).toHaveLength(1)
    expect(report.actions[0]?.status).toBe("planned")
    expect(report.actions[0]?.reason).toBe("failed_burst")
    expect(after).toBe(before)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("queues escalated work and records supervisor intervention when applied", async () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicSchedulerQueueRecord(repository, {
      dispatchID: "docs-fail-1",
      queueType: "seat-response",
      status: "failed",
      deliberationID: "order-system",
      phase: "collaboration",
      sourceMessageID: "question-1",
      targetSeatID: "docs-seat",
      requestedAgent: "ling",
      files: ["README.md"],
      summary: "first weak-model failure",
    })
    appendRepublicSchedulerQueueRecord(repository, {
      dispatchID: "docs-fail-2",
      queueType: "seat-response",
      status: "failed",
      deliberationID: "order-system",
      phase: "collaboration",
      sourceMessageID: "question-1",
      targetSeatID: "docs-seat",
      requestedAgent: "ling",
      files: ["README.md"],
      summary: "second weak-model failure",
    })

    const exitCode = await silenceConsole(() => republicEscalate({
      directory,
      deliberationId: "order-system",
      maxFailedPerSource: 1,
      escalationAgent: "hephaestus",
      apply: true,
    }))
    const queue = readRepublicSchedulerQueueRecords(repository, "order-system")
    const messages = readRepublicCommonsMessages(repository, "order-system")
    const escalation = queue.find((record) => record.reason === "auto_escalation_failed_burst")

    expect(exitCode).toBe(0)
    expect(escalation?.status).toBe("queued")
    expect(escalation?.requestedAgent).toBe("hephaestus")
    expect(messages.at(-1)?.messageType).toBe("intervention")
    expect(messages.at(-1)?.status).toBe("escalated")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("detects stale pending dispatches by ttl", () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicSchedulerQueueRecord(repository, {
      dispatchID: "pending-docs-1",
      queueType: "seat-response",
      status: "queued",
      deliberationID: "order-system",
      sourceMessageID: "question-2",
      targetSeatID: "docs-seat",
      requestedAgent: "ling",
      summary: "pending docs response",
    })
    const queuePath = getRepublicSchedulerQueuePath(repository)
    const original = readFileSync(queuePath, "utf-8")
    writeFileSync(queuePath, original.replace(/"timestamp":"[^"]+"/, '"timestamp":"2026-01-01T00:00:00.000Z"'), "utf-8")

    const report = buildRepublicEscalationReport({
      directory,
      deliberationId: "order-system",
      maxPendingAgeMs: 1000,
      now: new Date("2026-01-01T00:00:03.000Z"),
      escalationAgent: "hephaestus",
    })

    expect(report.actions[0]?.reason).toBe("pending_ttl")
    expect(report.actions[0]?.pendingAgeMs).toBe(3000)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
