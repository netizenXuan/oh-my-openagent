/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository } from "./native-git"
import {
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  evaluateRepublicDecision,
  getRepublicCommonsPath,
  getRepublicDeliberationDir,
  getRepublicLedgerPath,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  sanitizeRepublicDeliberationID,
  summarizeRepublicCommons,
  summarizeRepublicCommonsMessages,
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
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-contract",
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
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-review",
      dependsOn: ["api-contract"],
      supervisorSeatID: "chief-reviewer",
      status: "blocked",
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
    expect(summary.workgroups["api-workgroup"]).toBe(2)
    expect(summary.modules.api).toBe(2)
    expect(summary.tasks).toEqual(["api-contract", "api-review"])
    expect(summary.seats).toEqual(["planner-house-1", "reviewer-bench-1"])
    expect(summary.votes.approve).toBe(1)
    expect(summary.votes.reject).toBe(1)
    expect(summary.averageConfidence).toBe(0.8)
    expect(summary.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(summary.blocked).toBe(true)
  })

  test("writes commons messages under git common dir without dirtying the worktree", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    const commonsPath = appendRepublicCommonsMessage(repository!, {
      deliberationID: "agent republic",
      channel: "house-planning",
      phase: "seat-proposal",
      round: 0,
      authorSeatID: "planner-house-1",
      authorAgent: "prometheus",
      authorRole: "planner",
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-contract",
      status: "planned",
      messageType: "proposal",
      files: ["src/a.ts"],
      confidence: 0.8,
      content: "Prefer a ledger-first implementation.",
    })

    expect(commonsPath).toBe(getRepublicCommonsPath(repository!))
    expect(commonsPath).toContain(join(".git", "omo", "republic", "commons.jsonl"))
    expect(existsSync(commonsPath)).toBe(true)
    expect(readFileSync(commonsPath, "utf-8")).toContain('"messageType":"proposal"')
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("reads and summarizes commons messages by deliberation id", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    appendRepublicCommonsMessage(repository!, {
      messageID: "proposal-1",
      deliberationID: "agent republic",
      channel: "house-planning",
      phase: "seat-proposal",
      round: 0,
      authorSeatID: "planner-house-1",
      authorAgent: "prometheus",
      authorRole: "planner",
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-contract",
      status: "planned",
      messageType: "proposal",
      files: ["src/a.ts"],
      confidence: 0.7,
      content: "Use independent seat proposals.",
    })
    appendRepublicCommonsMessage(repository!, {
      deliberationID: "agent republic",
      channel: "house-planning",
      phase: "cross-examination",
      round: 1,
      authorSeatID: "planner-house-2",
      authorAgent: "prometheus",
      authorRole: "planner",
      targetSeatID: "planner-house-1",
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-review",
      dependsOn: ["api-contract"],
      supervisorSeatID: "chief-planner",
      status: "blocked",
      messageType: "objection",
      references: ["proposal-1"],
      files: ["src/b.ts"],
      confidence: 0.6,
      content: "Question whether the proposal has enough rollback detail.",
    })
    appendRepublicCommonsMessage(repository!, {
      deliberationID: "other",
      channel: "review-bench",
      phase: "review",
      authorSeatID: "reviewer-bench-1",
      messageType: "note",
      content: "Different deliberation.",
    })

    const messages = readRepublicCommonsMessages(repository!, "agent republic")
    const summary = summarizeRepublicCommons(repository!, "agent republic")

    expect(messages).toHaveLength(2)
    expect(summarizeRepublicCommonsMessages(messages, "agent republic")).toEqual(summary)
    expect(summary.deliberationID).toBe("agent-republic")
    expect(summary.messageCount).toBe(2)
    expect(summary.channels["house-planning"]).toBe(2)
    expect(summary.phases["seat-proposal"]).toBe(1)
    expect(summary.phases["cross-examination"]).toBe(1)
    expect(summary.authors["planner-house-1"]).toBe(1)
    expect(summary.authors["planner-house-2"]).toBe(1)
    expect(summary.agents.prometheus).toBe(2)
    expect(summary.workgroups["api-workgroup"]).toBe(2)
    expect(summary.modules.api).toBe(2)
    expect(summary.tasks).toEqual(["api-contract", "api-review"])
    expect(summary.messageTypes.proposal).toBe(1)
    expect(summary.messageTypes.objection).toBe(1)
    expect(summary.targetedMessages).toBe(1)
    expect(summary.referencedMessages).toBe(1)
    expect(summary.files).toEqual(["src/a.ts", "src/b.ts"])
    expect(summary.latestContent).toBe("Question whether the proposal has enough rollback detail.")
  })

  test("evaluates quorum, blocker veto, and supermajority decisions", () => {
    const baseSummary = summarizeRepublicLedgerRecords([
      {
        deliberationID: "decision",
        phase: "seat-proposal",
        seatID: "seat-1",
        vote: "approve",
      },
    ], "decision")

    expect(evaluateRepublicDecision(summarizeRepublicLedgerRecords([], "decision")).status).toBe("no-records")
    expect(evaluateRepublicDecision(baseSummary).status).toBe("needs-quorum")

    const blockedSummary = summarizeRepublicLedgerRecords([
      {
        deliberationID: "decision",
        phase: "review",
        seatID: "bench-1",
        vote: "reject",
        summary: "Blocker: no rollback path.",
      },
      {
        deliberationID: "decision",
        phase: "seat-proposal",
        seatID: "seat-1",
        vote: "approve",
      },
      {
        deliberationID: "decision",
        phase: "seat-proposal",
        seatID: "seat-2",
        vote: "approve",
      },
      {
        deliberationID: "decision",
        phase: "seat-proposal",
        seatID: "seat-3",
        vote: "approve",
      },
    ], "decision")
    expect(evaluateRepublicDecision(blockedSummary).status).toBe("blocked")

    const approvedSummary = summarizeRepublicLedgerRecords([
      { deliberationID: "decision", phase: "seat-proposal", seatID: "seat-1", vote: "approve" },
      { deliberationID: "decision", phase: "seat-proposal", seatID: "seat-2", vote: "approve" },
      { deliberationID: "decision", phase: "seat-proposal", seatID: "seat-3", vote: "approve" },
      { deliberationID: "decision", phase: "review", seatID: "bench-1", vote: "revise" },
    ], "decision")
    expect(evaluateRepublicDecision(approvedSummary).status).toBe("approved")

    const reviseSummary = summarizeRepublicLedgerRecords([
      { deliberationID: "decision", phase: "seat-proposal", seatID: "seat-1", vote: "approve" },
      { deliberationID: "decision", phase: "seat-proposal", seatID: "seat-2", vote: "revise" },
      { deliberationID: "decision", phase: "seat-proposal", seatID: "seat-3", vote: "revise" },
      { deliberationID: "decision", phase: "review", seatID: "bench-1", vote: "revise" },
    ], "decision")
    expect(evaluateRepublicDecision(reviseSummary).status).toBe("revise")
  })
})
