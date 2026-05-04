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
} from "../../shared/git-worktree"
import {
  buildRepublicDashboardData,
  renderRepublicDashboardHtml,
  writeRepublicDashboardFile,
} from "./dashboard"

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
    "user.name=Republic Dashboard Test",
    "-c",
    "user.email=republic-dashboard@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

describe("republic dashboard", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-dashboard-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("builds graph data from ledger, commons, and native git audit records", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()

    appendRepublicLedgerRecord(repository!, {
      deliberationID: "large project",
      phase: "seat-proposal",
      chamber: "house",
      seatID: "planner-house-1",
      role: "planner",
      agent: "prometheus",
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-contract",
      status: "in-progress",
      vote: "approve",
      files: ["src/api/routes.ts"],
      summary: "Split API and UI modules.",
    })
    appendRepublicCommonsMessage(repository!, {
      messageID: "house-1-r0-proposal",
      deliberationID: "large project",
      channel: "api-workgroup",
      phase: "seat-proposal",
      round: 0,
      authorSeatID: "planner-house-1",
      authorAgent: "prometheus",
      authorRole: "planner",
      workgroupID: "api-workgroup",
      module: "api",
      taskID: "api-contract",
      status: "in-progress",
      messageType: "proposal",
      files: ["src/api/routes.ts"],
      content: "API workgroup should own route contracts.",
    })
    appendRepublicCommonsMessage(repository!, {
      messageID: "house-2-r1-question",
      deliberationID: "large project",
      channel: "ui-workgroup",
      phase: "cross-examination",
      round: 1,
      authorSeatID: "planner-house-2",
      authorAgent: "prometheus",
      targetSeatID: "planner-house-1",
      workgroupID: "ui-workgroup",
      module: "ui",
      taskID: "ui-contract",
      dependsOn: ["api-contract"],
      supervisorSeatID: "chief-coordinator",
      status: "blocked",
      messageType: "question",
      references: ["house-1-r0-proposal"],
      files: ["src/ui/page.tsx"],
      content: "How will UI handle API contract drift?",
    })
    appendNativeGitAuditRecord(repository!, {
      tool: "edit",
      agent: "atlas",
      model: "kimi-for-coding/k2p6",
      files: ["src/api/routes.ts"],
      summary: "API route file changed",
    })

    const data = buildRepublicDashboardData({ directory, deliberationId: "large project" })

    expect(data.repository?.repoRoot).toBe(directory.replace(/\\/g, "/"))
    expect(data.report.commons.messageCount).toBe(2)
    expect(data.nodes.some((node) => node.id === "seat:planner-house-1")).toBe(true)
    expect(data.nodes.some((node) => node.id === "agent:prometheus")).toBe(true)
    expect(data.nodes.some((node) => node.id === "workgroup:api-workgroup")).toBe(true)
    expect(data.nodes.some((node) => node.id === "workgroup:ui-workgroup")).toBe(true)
    expect(data.nodes.some((node) => node.id === "task:api-contract")).toBe(true)
    expect(data.nodes.some((node) => node.id === "task:ui-contract")).toBe(true)
    expect(data.nodes.some((node) => node.id === "seat:chief-coordinator")).toBe(true)
    expect(data.nodes.some((node) => node.id === "module:src")).toBe(true)
    expect(data.nodes.some((node) => node.id === "module:api")).toBe(true)
    expect(data.nodes.some((node) => node.id === "module:ui")).toBe(true)
    expect(data.nodes.some((node) => node.id === "file:src/api/routes.ts")).toBe(true)
    expect(data.edges.some((edge) => edge.type === "targets")).toBe(true)
    expect(data.edges.some((edge) => edge.type === "references")).toBe(true)
    expect(data.edges.some((edge) => edge.type === "changed")).toBe(true)
    expect(data.edges.some((edge) => edge.type === "supervises")).toBe(true)
    expect(data.edges.some((edge) => edge.type === "depends-on")).toBe(true)
  })

  test("writes a static html dashboard under git common dir without dirtying the worktree", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const outputPath = writeRepublicDashboardFile({ directory })

    expect(outputPath).toContain(join(".git", "omo", "republic", "dashboard.html"))
    expect(existsSync(outputPath)).toBe(true)
    const html = readFileSync(outputPath, "utf-8")
    expect(html).toContain("OMO Republic Dashboard")
    expect(html).toContain("republic-data")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("renders live dashboard html that polls data json", () => {
    const data = buildRepublicDashboardData({ directory })
    const html = renderRepublicDashboardHtml(data, { live: true, refreshMs: 500 })

    expect(html).toContain('fetch("/data.json"')
    expect(html).toContain("setInterval(render, 500)")
  })
})
