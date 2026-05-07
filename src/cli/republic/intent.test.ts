/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository, readRepublicCommonsMessages } from "../../shared/git-worktree"
import { buildRepublicIntentReport, republicIntent } from "./intent"

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
    "user.name=Republic Intent Test",
    "-c",
    "user.email=republic-intent@example.test",
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

describe("republic intent", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-intent-"))
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("publishes staged changes as a Commons proposal without committing", async () => {
    writeFileSync(join(directory, "README.md"), "hello\nintent\n", "utf-8")
    git(directory, ["add", "README.md"])

    const report = buildRepublicIntentReport({
      directory,
      deliberationId: "intent-smoke",
      seatId: "api-seat",
      targetSeatId: "review-seat",
      workgroupId: "api-workgroup",
      message: "Please review staged README changes.",
    })
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "intent-smoke")

    expect(report.published).toBe(true)
    expect(report.stagedFiles).toEqual(["README.md"])
    expect(report.inserted).toBe(1)
    expect(messages[0]?.messageType).toBe("proposal")
    expect(messages[0]?.targetSeatID).toBe("review-seat")
    expect(messages[0]?.content).toContain("Staged files: README.md")
    expect(git(directory, ["status", "--porcelain"])).toContain("M  README.md")
    expect(git(directory, ["log", "--oneline", "-1"])).toContain("init")
  })

  test("fails when there are no staged changes", async () => {
    const exitCode = await silenceConsole(() => republicIntent({
      directory,
      deliberationId: "intent-smoke",
      seatId: "api-seat",
    }))

    expect(exitCode).toBe(1)
  })

  test("writes json output for staged intent reports", async () => {
    writeFileSync(join(directory, "README.md"), "hello\nintent\n", "utf-8")
    git(directory, ["add", "README.md"])
    const output = join(directory, "..", "intent.json")

    const exitCode = await republicIntent({
      directory,
      deliberationId: "intent-smoke",
      seatId: "api-seat",
      output,
      json: true,
    })

    expect(exitCode).toBe(0)
    expect(readFileSync(output, "utf-8")).toContain('"published": true')
  })
})
