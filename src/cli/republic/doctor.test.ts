/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  getNativeGitRepository,
} from "../../shared/git-worktree"
import { buildRepublicDoctorReport, formatRepublicDoctorReport, republicDoctor } from "./doctor"

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
    "user.name=Republic Doctor Test",
    "-c",
    "user.email=republic-doctor@example.test",
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

describe("republic doctor", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-doctor-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("fails outside a git repository", async () => {
    const report = buildRepublicDoctorReport({ directory })

    expect(report.healthy).toBe(false)
    expect(report.checks[0]?.name).toBe("git-repository")
    expect(report.checks[0]?.status).toBe("fail")
    expect(formatRepublicDoctorReport(report)).toContain("attention-required")
    expect(await silenceConsole(() => republicDoctor({ directory }))).toBe(1)
  })

  test("passes advisory mode with a git repository and warns on missing republic activity", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const report = buildRepublicDoctorReport({ directory })

    expect(report.healthy).toBe(true)
    expect(report.checks.find((check) => check.name === "republic-ledger")?.status).toBe("warn")
    expect(formatRepublicDoctorReport(report)).toContain("Result: healthy")
  })

  test("passes strict mode once ledger and commons activity exist", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicLedgerRecord(repository!, {
      deliberationID: "doctor-smoke",
      phase: "planning",
      seatID: "api-seat",
      agent: "prometheus",
      vote: "approve",
      summary: "Plan approved.",
    })
    appendRepublicCommonsMessage(repository!, {
      deliberationID: "doctor-smoke",
      channel: "commons",
      phase: "planning",
      authorSeatID: "api-seat",
      targetSeatID: "test-seat",
      messageType: "question",
      content: "Please verify the plan.",
    })

    const report = buildRepublicDoctorReport({
      directory,
      deliberationId: "doctor-smoke",
      strict: true,
    })

    expect(report.healthy).toBe(true)
    expect(report.checks.every((check) => check.status !== "fail")).toBe(true)
    expect(report.checks.find((check) => check.name === "republic-ledger")?.status).toBe("pass")
    expect(report.checks.find((check) => check.name === "republic-commons")?.status).toBe("pass")
  })
})
