/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  readRepublicSchedulerQueueRecords,
} from "../../shared/git-worktree"
import { buildRepublicGCReport, republicGC } from "./gc"

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
    "user.name=Republic GC Test",
    "-c",
    "user.email=republic-gc@example.test",
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

describe("republic gc", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-gc-"))
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("plans matched active records without modifying Republic files", () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      deliberationID: "weak-model",
      channel: "commons",
      phase: "planning",
      authorSeatID: "ling-seat",
      messageType: "note",
      content: "noisy note",
    })

    const before = readFileSync(join(repository.gitCommonDir, "omo", "republic", "commons.jsonl"), "utf-8")
    const report = buildRepublicGCReport({
      directory,
      deliberationId: "weak-model",
      seatId: ["ling-seat"],
      messageType: ["note"],
    })
    const after = readFileSync(join(repository.gitCommonDir, "omo", "republic", "commons.jsonl"), "utf-8")

    expect(report.applied).toBe(false)
    expect(report.files[0]?.selectedRecords).toBe(1)
    expect(after).toBe(before)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("archives originals and compacts matching records when applied", async () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      deliberationID: "weak-model",
      channel: "commons",
      phase: "planning",
      authorSeatID: "ling-seat",
      messageType: "note",
      content: "remove this noisy note",
    })
    appendRepublicCommonsMessage(repository, {
      deliberationID: "weak-model",
      channel: "commons",
      phase: "planning",
      authorSeatID: "api-seat",
      messageType: "proposal",
      content: "keep this proposal",
    })
    appendRepublicLedgerRecord(repository, {
      deliberationID: "weak-model",
      phase: "planning",
      seatID: "ling-seat",
      summary: "remove noisy ledger",
    })
    appendRepublicSchedulerQueueRecord(repository, {
      dispatchID: "failed-1",
      queueType: "seat-response",
      status: "failed",
      deliberationID: "weak-model",
      targetSeatID: "ling-seat",
      summary: "remove failed dispatch",
    })

    const exitCode = await silenceConsole(() => republicGC({
      directory,
      deliberationId: "weak-model",
      seatId: ["ling-seat"],
      apply: true,
      reason: "Compacting failed weak-model run.",
    }))
    const commons = readRepublicCommonsMessages(repository, "weak-model")
    const ledger = readRepublicLedgerRecords(repository, "weak-model")
    const queue = readRepublicSchedulerQueueRecords(repository, "weak-model")
    const archiveDir = join(repository.gitCommonDir, "omo", "republic", "archive")

    expect(exitCode).toBe(0)
    expect(commons.some((message) => message.content.includes("remove this noisy note"))).toBe(false)
    expect(commons.some((message) => message.messageType === "intervention")).toBe(true)
    expect(ledger).toHaveLength(0)
    expect(queue).toHaveLength(0)
    expect(existsSync(archiveDir)).toBe(true)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
