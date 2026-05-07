/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendRepublicCommonsMessage, getNativeGitRepository, readRepublicCommonsMessages } from "../../shared/git-worktree"
import { buildRepublicEvaluationReport, republicEvaluate } from "./evaluate"

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
    "user.name=Republic Evaluate Test",
    "-c",
    "user.email=republic-evaluate@example.test",
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

describe("republic evaluate", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-evaluate-"))
    git(directory, ["init"])
    writeFileSync(join(directory, "orders.ts"), "export const status = 'pending'\n", "utf-8")
    commitAll(directory, "init")
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("writes an evaluator prompt in git common dir without dirtying the worktree", () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      deliberationID: "order-system",
      channel: "commons",
      phase: "planning",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      messageType: "question",
      content: "Should status include delivered?",
    })

    const report = buildRepublicEvaluationReport({
      directory,
      deliberationId: "order-system",
      evaluatorSeatId: "validator-seat",
      writePrompt: true,
      evidenceFile: ["orders.ts"],
    })

    expect(report.promptPath).toContain(join(".git", "omo", "republic", "evaluator", "prompts"))
    expect(existsSync(report.promptPath!)).toBe(true)
    const prompt = readFileSync(report.promptPath!, "utf-8")
    expect(prompt).toContain("independent semantic evaluator seat")
    expect(prompt).toContain("Should status include delivered?")
    expect(prompt).toContain("orders.ts")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("records a fail verdict as a Commons objection", async () => {
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      messageID: "proposal-1",
      deliberationID: "order-system",
      channel: "intent",
      phase: "review",
      authorSeatID: "api-seat",
      messageType: "proposal",
      content: "Implementation proposal.",
    })

    const exitCode = await silenceConsole(() => republicEvaluate({
      directory,
      deliberationId: "order-system",
      evaluatorSeatId: "validator-seat",
      targetMessageId: "proposal-1",
      result: "fail",
      summary: "Semantic fail: delivered status is not implemented.",
      evidenceFile: ["orders.ts"],
    }))
    const messages = readRepublicCommonsMessages(repository, "order-system")
    const verdict = messages.at(-1)

    expect(exitCode).toBe(0)
    expect(verdict?.authorSeatID).toBe("validator-seat")
    expect(verdict?.messageType).toBe("objection")
    expect(verdict?.status).toBe("blocked")
    expect(verdict?.references).toEqual(["proposal-1"])
    expect(verdict?.files).toEqual(["orders.ts"])
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
