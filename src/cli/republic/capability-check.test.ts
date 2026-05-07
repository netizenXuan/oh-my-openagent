/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRepublicCommonsMessage,
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
} from "../../shared/git-worktree"
import {
  buildRepublicCapabilityReport,
  formatRepublicCapabilityReport,
  republicCapabilityCheck,
} from "./capability-check"

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
    "user.name=Republic Capability Test",
    "-c",
    "user.email=republic-capability@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

describe("republic capability check", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-capability-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("passes when a seat response matches hard fields and scheduler dispatch", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicCommonsMessage(repository!, {
      messageID: "question-1",
      deliberationID: "orders",
      channel: "commons",
      phase: "planning",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      messageType: "question",
      content: "What enum values should OrderStatus use?",
    })
    appendRepublicCommonsMessage(repository!, {
      messageID: "answer-1",
      deliberationID: "orders",
      channel: "commons",
      phase: "planning",
      authorSeatID: "docs-seat",
      targetSeatID: "api-seat",
      messageType: "answer",
      references: ["question-1"],
      content: "Use OrderStatus values pending, confirmed, shipped, delivered, cancelled.",
    })
    appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "dispatch-docs-1",
      queueType: "seat-response",
      status: "queued",
      deliberationID: "orders",
      sourceMessageID: "question-1",
      sourceMessageType: "question",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      summary: "Docs answer needed.",
    })
    appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "dispatch-docs-1",
      queueType: "seat-response",
      status: "dispatched",
      deliberationID: "orders",
      sourceMessageID: "question-1",
      sourceMessageType: "question",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      runtimeAgent: "sisyphus",
      summary: "Docs launched.",
    })

    const report = buildRepublicCapabilityReport({
      directory,
      deliberationId: "orders",
      dispatchId: "dispatch-docs-1",
      sourceMessageId: "question-1",
      expectedAuthorSeat: "docs-seat",
      expectedTargetSeat: "api-seat",
      requireContent: ["OrderStatus", "delivered"],
      expectCleanWorktree: true,
      requireDispatchedQueue: true,
    })

    expect(report.passed).toBe(true)
    expect(report.failures).toBe(0)
    expect(report.matchingResponses).toHaveLength(1)
    expect(report.matchingQueueRecords).toHaveLength(1)
    expect(formatRepublicCapabilityReport(report)).toContain("Result: pass")
  })

  test("fails when no response references the source message", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicCommonsMessage(repository!, {
      messageID: "question-1",
      deliberationID: "orders",
      channel: "commons",
      phase: "planning",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      messageType: "question",
      content: "What enum values should OrderStatus use?",
    })

    const report = buildRepublicCapabilityReport({
      directory,
      deliberationId: "orders",
      sourceMessageId: "question-1",
      expectedAuthorSeat: "docs-seat",
      expectedTargetSeat: "api-seat",
    })

    expect(report.passed).toBe(false)
    expect(report.checks.find((check) => check.name === "commons-response")?.status).toBe("fail")
  })

  test("can validate an indirect Commons reference graph", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicCommonsMessage(repository!, {
      messageID: "question-1",
      deliberationID: "orders",
      channel: "commons",
      phase: "planning",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      messageType: "question",
      content: "What enum values should OrderStatus use?",
    })
    appendRepublicCommonsMessage(repository!, {
      messageID: "helper-answer-1",
      deliberationID: "orders",
      channel: "commons",
      phase: "planning",
      authorSeatID: "test-seat",
      targetSeatID: "docs-seat",
      messageType: "answer",
      references: ["question-1"],
      content: "The test matrix uses pending and delivered.",
    })
    appendRepublicCommonsMessage(repository!, {
      messageID: "answer-1",
      deliberationID: "orders",
      channel: "commons",
      phase: "planning",
      authorSeatID: "docs-seat",
      targetSeatID: "api-seat",
      messageType: "answer",
      references: ["helper-answer-1"],
      content: "Final OrderStatus values include pending, confirmed, shipped, delivered, cancelled.",
    })

    const strictReport = buildRepublicCapabilityReport({
      directory,
      deliberationId: "orders",
      sourceMessageId: "question-1",
      expectedAuthorSeat: "docs-seat",
      expectedTargetSeat: "api-seat",
      requireContent: ["delivered"],
    })
    const graphReport = buildRepublicCapabilityReport({
      directory,
      deliberationId: "orders",
      sourceMessageId: "question-1",
      expectedAuthorSeat: "docs-seat",
      expectedTargetSeat: "api-seat",
      requireContent: ["delivered"],
      allowIndirect: true,
    })

    expect(strictReport.passed).toBe(false)
    expect(graphReport.passed).toBe(true)
    expect(graphReport.matchingResponses[0]?.messageID).toBe("answer-1")
  })

  test("fails clean-worktree check when the model dirties the repository", async () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")
    writeFileSync(join(directory, "scratch.md"), "dirty\n", "utf-8")

    const logs: string[] = []
    const originalLog = console.log
    console.log = (value?: unknown) => {
      logs.push(String(value ?? ""))
    }
    try {
      const exitCode = await republicCapabilityCheck({
        directory,
        expectCleanWorktree: true,
      })

      expect(exitCode).toBe(1)
      expect(logs.join("\n")).toContain("clean-worktree")
      expect(logs.join("\n")).toContain("scratch.md")
    } finally {
      console.log = originalLog
    }
  })
})
