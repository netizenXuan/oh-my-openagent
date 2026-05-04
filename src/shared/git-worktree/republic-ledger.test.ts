/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository } from "./native-git"
import {
  appendRepublicLedgerRecord,
  getRepublicDeliberationDir,
  getRepublicLedgerPath,
  sanitizeRepublicDeliberationID,
} from "./republic-ledger"

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
    "user.name=Republic Ledger Test",
    "-c",
    "user.email=republic-ledger@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

describe("republic ledger", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-ledger-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("sanitizes deliberation ids for git common dir paths", () => {
    expect(sanitizeRepublicDeliberationID("../Native Git Review!")).toBe("Native-Git-Review")
    expect(sanitizeRepublicDeliberationID("")).toBe("deliberation")
  })

  test("writes ledger under git common dir without dirtying the worktree", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    const ledgerPath = appendRepublicLedgerRecord(repository!, {
      deliberationID: "native git review",
      phase: "seat-proposal",
      chamber: "house",
      seatID: "planner-1",
      role: "planner",
      agent: "prometheus",
      model: "test-model",
      vote: "approve",
      confidence: 0.8,
      files: ["README.md"],
      summary: "Plan is feasible with focused tests.",
    })

    expect(ledgerPath).toBe(getRepublicLedgerPath(repository!))
    expect(ledgerPath).toContain(join(".git", "omo", "republic", "ledger.jsonl"))
    expect(getRepublicDeliberationDir(repository!, "native git review")).toContain(
      join(".git", "omo", "republic", "deliberations", "native-git-review"),
    )
    expect(existsSync(ledgerPath)).toBe(true)
    const ledger = readFileSync(ledgerPath, "utf-8")
    expect(ledger).toContain('"deliberationID":"native-git-review"')
    expect(ledger).toContain('"seatID":"planner-1"')
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
