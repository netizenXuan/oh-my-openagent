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
  appendRepublicSchedulerQueueRecord,
  analyzeRepublicContractTraceability,
  evaluateRepublicDecision,
  getRepublicAgentDocPath,
  getRepublicCommonsPath,
  getRepublicContractPath,
  getRepublicDeliberationDir,
  getRepublicLedgerPath,
  getRepublicSchedulerQueuePath,
  readRepublicAgentDoc,
  readRepublicCommonsMessages,
  readRepublicInboxMessages,
  readRepublicLedgerRecords,
  readRepublicSchedulerQueueRecords,
  sanitizeRepublicDeliberationID,
  summarizeRepublicCommons,
  summarizeRepublicCommonsMessages,
  summarizeRepublicLedger,
  summarizeRepublicLedgerRecords,
  summarizeRepublicSchedulerQueue,
  writeRepublicContract,
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
    expect(existsSync(getRepublicAgentDocPath(repository!, "planner-house-1"))).toBe(true)
    expect(readRepublicAgentDoc(repository!, "planner-house-1")).toContain("Prefer a ledger-first implementation.")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("writes targeted messages into both agent docs and filters inbox messages", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    appendRepublicCommonsMessage(repository!, {
      deliberationID: "agent republic",
      channel: "commons",
      phase: "cross-examination",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      workgroupID: "docs-workgroup",
      module: "docs/api",
      messageType: "question",
      content: "Can docs publish the response shape before API implementation?",
    })
    appendRepublicCommonsMessage(repository!, {
      deliberationID: "agent republic",
      channel: "commons",
      phase: "supervision",
      authorSeatID: "republic-supervisor",
      targetSeatID: "api-seat",
      messageType: "supervisor-policy",
      content: "Resolve the outstanding docs question before finalizing.",
    })

    const docsInbox = readRepublicInboxMessages(repository!, {
      deliberationID: "agent republic",
      seatID: "docs-seat",
      workgroupID: "docs-workgroup",
    })
    const docsDoc = readRepublicAgentDoc(repository!, "docs-seat")
    const apiDoc = readRepublicAgentDoc(repository!, "api-seat")

    expect(docsInbox.map((message) => message.messageType)).toContain("question")
    expect(docsDoc).toContain("Can docs publish")
    expect(apiDoc).toContain("Can docs publish")
    expect(apiDoc).toContain("Resolve the outstanding docs question")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("writes scheduler queue under git common dir without dirtying the worktree", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    const queuePath = appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "docs-seat-dispatch-1",
      queueType: "seat-response",
      status: "queued",
      reason: "manager_unavailable",
      deliberationID: "agent republic",
      phase: "collaboration",
      sourceMessageID: "msg-1",
      sourceMessageType: "question",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      files: ["README.md"],
      summary: "Queue docs-seat for a response.",
    })
    appendRepublicSchedulerQueueRecord(repository!, {
      dispatchID: "docs-seat-dispatch-1",
      timestamp: "2000-01-01T00:00:00.000Z",
      queueType: "seat-response",
      status: "dispatched",
      deliberationID: "agent republic",
      phase: "dispatch",
      sourceMessageID: "msg-1",
      sourceMessageType: "question",
      targetSeatID: "docs-seat",
      requestedAgent: "sisyphus",
      runtimeAgent: "general",
      taskID: "bg_1",
      summary: "Dispatched docs-seat.",
    })

    const records = readRepublicSchedulerQueueRecords(repository!, "agent republic")
    const summary = summarizeRepublicSchedulerQueue(repository!, "agent republic")

    expect(queuePath).toBe(getRepublicSchedulerQueuePath(repository!))
    expect(queuePath).toContain(join(".git", "omo", "republic", "scheduler", "queue.jsonl"))
    expect(records).toHaveLength(2)
    expect(records[0]?.status).toBe("queued")
    expect(records[1]?.taskID).toBe("bg_1")
    expect(records[1]?.timestamp).not.toBe("2000-01-01T00:00:00.000Z")
    expect(summary.recordCount).toBe(2)
    expect(summary.pending).toBe(0)
    expect(summary.queued).toBe(1)
    expect(summary.dispatched).toBe(1)
    expect(summary.targetSeats["docs-seat"]).toBe(2)
    expect(summary.requestedAgents.sisyphus).toBe(2)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("writes workgroup contracts under git common dir", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    const contractPath = writeRepublicContract(repository!, {
      workgroupID: "api-workgroup",
      module: "src/api",
      title: "Order response shape",
      content: "API returns id, status, and total.",
      authorSeatID: "api-seat",
      status: "proposed",
      files: ["src/api/orders.ts", "docs/api/orders.md"],
    })

    expect(contractPath).toBe(getRepublicContractPath(repository!, "api-workgroup"))
    expect(readFileSync(contractPath, "utf-8")).toContain("Order response shape")
    expect(readFileSync(contractPath, "utf-8")).toContain("API returns id")
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

  test("analyzes contract traceability against governed files", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    writeFileSync(join(directory, "orders.ts"), [
      'export type OrderStatus = "accepted" | "cancelled" | "shipped"',
      "export function cancelOrder(currentStatus: OrderStatus) {",
      '  return currentStatus === "accepted" ? "cancelled" : "cannot_cancel"',
      "}",
      "",
    ].join("\n"), "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    writeRepublicContract(repository!, {
      workgroupID: "api-workgroup",
      title: "Orders API Contract",
      authorSeatID: "api-seat",
      files: ["orders.ts"],
      content: 'The API must expose OrderStatus, cancelOrder, "accepted", "cancelled", "shipped", and "cannot_cancel".',
    })

    const summary = analyzeRepublicContractTraceability(repository!)
    expect(summary.contractCount).toBe(1)
    expect(summary.warningCount).toBe(0)
    expect(summary.items[0]?.coveredTerms).toContain("OrderStatus")
    expect(summary.items[0]?.coveredTerms).toContain("cannot_cancel")
    expect(summary.items[0]?.status).toBe("pass")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("flags missing files and uncovered contract terms", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    writeFileSync(join(directory, "orders.ts"), "export const status = \"accepted\"\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    writeRepublicContract(repository!, {
      workgroupID: "api-workgroup",
      title: "Orders API Contract",
      authorSeatID: "api-seat",
      files: ["orders.ts", "missing-docs.md"],
      content: "The API must expose cancelOrder and \"cannot_cancel\".",
    })

    const summary = analyzeRepublicContractTraceability(repository!)
    expect(summary.contractCount).toBe(1)
    expect(summary.warningCount).toBe(1)
    expect(summary.items[0]?.missingFiles).toEqual(["missing-docs.md"])
    expect(summary.items[0]?.uncoveredTerms).toContain("cancelOrder")
    expect(summary.items[0]?.uncoveredTerms).toContain("cannot_cancel")
    expect(summary.items[0]?.status).toBe("warning")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("ignores prose heading words when tracing contract terms", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "orders.ts"), [
      'export interface ReturnLine { sku: string; quantity: number; restockable: boolean }',
      'export interface Refund { refundID: string; amount: number }',
      'export function processReturn() { return "order_not_delivered" }',
      "",
    ].join("\n"), "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    writeRepublicContract(repository!, {
      workgroupID: "return-workgroup",
      title: "Return Contract",
      authorSeatID: "api-seat",
      files: ["orders.ts"],
      content: [
        "Responsibilities:",
        "- Implement ReturnLine and Refund support.",
        "Interfaces:",
        "- processReturn returns \"order_not_delivered\" for invalid returns.",
        "Constraints:",
        "- Do not treat Date, Errors, or Responsibilities as required symbols.",
      ].join("\n"),
    })

    const summary = analyzeRepublicContractTraceability(repository!)
    expect(summary.warningCount).toBe(0)
    expect(summary.items[0]?.terms).toContain("ReturnLine")
    expect(summary.items[0]?.terms).toContain("processReturn")
    expect(summary.items[0]?.terms).not.toContain("Responsibilities")
    expect(summary.items[0]?.terms).not.toContain("Interfaces")
    expect(summary.items[0]?.terms).not.toContain("Date")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("reads governed file lists written inside contract prose", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "fulfillment.ts"), [
      'export interface ReturnLine { sku: string }',
      'export interface Refund { refundID: string }',
      'export function processReturn(state: unknown, orderID: string, refundID: string, returnLines: ReturnLine[]) { return "return_window_expired" }',
      "",
    ].join("\n"), "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    writeRepublicContract(repository!, {
      workgroupID: "return-workgroup",
      title: "Return Contract",
      authorSeatID: "api-seat",
      content: [
        "Files governed:",
        "  - fulfillment.ts",
        "",
        "Interfaces:",
        "- processReturn(state, orderID, refundID, returnLines)",
        "- Errors: return_window_expired",
        "- Domain types: ReturnLine and Refund",
        "- Refund formula: sum(returnedQty * unitPrice) - 0.10 * sum(nonRestockableQty * unitPrice)",
      ].join("\n"),
    })

    const summary = analyzeRepublicContractTraceability(repository!)
    expect(summary.warningCount).toBe(0)
    expect(summary.items[0]?.files).toEqual(["fulfillment.ts"])
    expect(summary.items[0]?.coveredTerms).toContain("return_window_expired")
    expect(summary.items[0]?.coveredTerms).toContain("processReturn")
    expect(summary.items[0]?.terms).not.toContain("returnedQty")
    expect(summary.items[0]?.terms).not.toContain("nonRestockableQty")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
