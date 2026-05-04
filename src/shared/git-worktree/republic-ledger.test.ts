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
  readRepublicLedgerRecords,
  sanitizeRepublicDeliberationID,
  summarizeRepublicLedger,
  summarizeRepublicLedgerRecords,
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

  test("reads and summarizes ledger records by deliberation id", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    appendRepublicLedgerRecord(repository!, {
      deliberationID: "agent republic",
      phase: "seat-proposal",
      chamber: "house",
      seatID: "planner-house-1",
      role: "planner",
      agent: "prometheus",
      vote: "approve",
      confidence: 0.7,
      files: ["src/a.ts"],
      summary: "Use a ledger-first plan.",
    })
    appendRepublicLedgerRecord(repository!, {
      deliberationID: "agent republic",
      phase: "review",
      chamber: "bench",
      seatID: "reviewer-bench-1",
      role: "reviewer",
      agent: "momus",
      vote: "reject",
      confidence: 0.9,
      files: ["src/b.ts"],
      summary: "Blocker: missing rollback path.",
    })
    appendRepublicLedgerRecord(repository!, {
      deliberationID: "other",
      phase: "brief",
      vote: "abstain",
      summary: "Different deliberation.",
    })

    const records = readRepublicLedgerRecords(repository!, "agent republic")
    const summary = summarizeRepublicLedger(repository!, "agent republic")

    expect(records).toHaveLength(2)
    expect(summarizeRepublicLedgerRecords(records, "agent republic")).toEqual(summary)
    expect(summary.deliberationID).toBe("agent-republic")
    expect(summary.recordCount).toBe(2)
    expect(summary.deliberationIDs).toEqual(["agent-republic"])
    expect(summary.phases["seat-proposal"]).toBe(1)
    expect(summary.phases.review).toBe(1)
    expect(summary.chambers.house).toBe(1)
    expect(summary.chambers.bench).toBe(1)
    expect(summary.agents.prometheus).toBe(1)
    expect(summary.agents.momus).toBe(1)
    expect(summary.seats).toEqual(["planner-house-1", "reviewer-bench-1"])
    expect(summary.votes.approve).toBe(1)
    expect(summary.votes.reject).toBe(1)
    expect(summary.averageConfidence).toBe(0.8)
    expect(summary.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(summary.blocked).toBe(true)
  })
})
