/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendNativeGitAuditRecord,
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  getNativeGitRepository,
  initializeRepublicTeam,
  writeRepublicContract,
} from "../../shared/git-worktree"
import {
  buildRepublicBenchmarkReport,
  formatRepublicBenchmarkReport,
  parseRepublicBenchmarkRun,
  republicBenchmarkReport,
} from "./benchmark-report"

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
    "user.name=Republic Benchmark Test",
    "-c",
    "user.email=republic-benchmark@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

function initRepo(directory: string): void {
  git(directory, ["init"])
  writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
  writeFileSync(join(directory, "orders.ts"), "export const OrderStatus = \"accepted\"\n", "utf-8")
  commitAll(directory, "init")
}

describe("republic benchmark report", () => {
  let root: string
  let control: string
  let treatment: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omo-republic-benchmark-"))
    control = join(root, "control")
    treatment = join(root, "treatment")
    execFileSync("git", ["init", control], { stdio: ["pipe", "pipe", "pipe"] })
    execFileSync("git", ["init", treatment], { stdio: ["pipe", "pipe", "pipe"] })
    initRepo(control)
    initRepo(treatment)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("parses run specs with explicit and inferred labels", () => {
    expect(parseRepublicBenchmarkRun(`control=${control}`)).toEqual({
      label: "control",
      directory: control,
    })
    expect(parseRepublicBenchmarkRun(treatment).label).toBe("treatment")
  })

  test("summarizes control and treatment repositories in markdown", () => {
    writeFileSync(join(control, "orders.ts"), "export const OrderStatus = \"cancelled\"\n", "utf-8")
    appendNativeGitAuditRecord(getNativeGitRepository(control)!, {
      tool: "edit",
      agent: "atlas",
      files: ["orders.ts"],
      summary: "orders.ts changed",
    })

    writeFileSync(
      join(treatment, "orders.ts"),
      'export type OrderStatus = "accepted" | "cancelled"\nexport function cancelOrder() { return "cancelled" }\n',
      "utf-8",
    )
    const treatmentRepo = getNativeGitRepository(treatment)!
    appendNativeGitAuditRecord(treatmentRepo, {
      tool: "bash",
      agent: "atlas",
      files: ["orders.ts"],
      summary: "orders.ts changed with contract",
    })
    appendRepublicLedgerRecord(treatmentRepo, {
      deliberationID: "order cancellation",
      phase: "planning",
      seatID: "api-seat",
      agent: "prometheus",
      workgroupID: "api-workgroup",
      vote: "approve",
      files: ["orders.ts"],
      summary: "API contract approved.",
    })
    appendRepublicLedgerRecord(treatmentRepo, {
      deliberationID: "order cancellation",
      phase: "review",
      seatID: "review-seat",
      agent: "momus",
      workgroupID: "api-workgroup",
      vote: "approve",
      files: ["orders.ts"],
      summary: "Implementation follows the contract.",
    })
    appendRepublicCommonsMessage(treatmentRepo, {
      deliberationID: "order cancellation",
      channel: "api-workgroup",
      phase: "cross-examination",
      authorSeatID: "api-seat",
      targetSeatID: "review-seat",
      messageType: "question",
      references: ["api-contract"],
      workgroupID: "api-workgroup",
      files: ["orders.ts"],
      content: "Please verify cancelOrder and OrderStatus.",
    })
    initializeRepublicTeam(treatmentRepo, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 3,
        defaultRuntimeAgent: "general",
        seats: [
          { seatID: "api-seat", role: "planner", phase: "planning", workgroupID: "api-workgroup" },
          { seatID: "test-seat", role: "reviewer", phase: "review", workgroupID: "test-workgroup" },
          { seatID: "republic-supervisor", role: "supervisor", phase: "planning" },
        ],
      },
    })
    writeRepublicContract(treatmentRepo, {
      workgroupID: "api-workgroup",
      title: "Order cancellation contract",
      authorSeatID: "api-seat",
      files: ["orders.ts"],
      content: 'Implementation must expose OrderStatus, cancelOrder, and "cancelled".',
    })

    const report = buildRepublicBenchmarkReport({
      runs: [
        { label: "control", directory: control },
        { label: "treatment", directory: treatment, deliberationId: "order cancellation" },
      ],
    })
    const markdown = formatRepublicBenchmarkReport(report)

    expect(report.runCount).toBe(2)
    expect(report.runs[0]?.dirtyFileCount).toBe(1)
    expect(report.runs[0]?.nativeGitRecords).toBe(1)
    expect(report.runs[0]?.ledgerRecords).toBe(0)
    expect(report.runs[1]?.ledgerRecords).toBe(2)
    expect(report.runs[1]?.commonsMessages).toBe(1)
    expect(report.runs[1]?.contracts).toBe(1)
    expect(report.runs[1]?.contractWarnings).toBe(0)
    expect(report.runs[1]?.seats).toBe(3)
    expect(report.runs[1]?.workgroups).toBe(2)
    expect(report.runs[1]?.targetedMessages).toBe(1)
    expect(report.runs[1]?.referencedMessages).toBe(1)
    expect(markdown).toContain("| control |")
    expect(markdown).toContain("| treatment |")
    expect(markdown).toContain("Use this report as an evidence index")
  })

  test("writes report output without mutating inspected repositories", async () => {
    const output = join(root, "reports", "benchmark.md")
    const exitCode = await republicBenchmarkReport({
      run: [{ label: "control", directory: control }],
      output,
    })

    expect(exitCode).toBe(0)
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(output, "utf-8")).toContain("OMO Republic Benchmark Report")
    expect(git(control, ["status", "--porcelain"])).toBe("")
  })
})
