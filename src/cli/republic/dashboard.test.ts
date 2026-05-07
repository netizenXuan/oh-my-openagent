/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendNativeGitAuditRecord,
  appendRepublicCommonsMessage,
  appendRepublicLedgerRecord,
  appendRepublicSchedulerQueueRecord,
  getNativeGitRepository,
  initializeRepublicTeam,
  writeRepublicContract,
} from "../../shared/git-worktree"
import {
  buildRepublicDashboardData,
  getDashboardOpenCommand,
  renderRepublicDashboardHtml,
  startRepublicDashboardServer,
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
    mkdirSync(join(directory, "src", "api"), { recursive: true })
    writeFileSync(join(directory, "src", "api", "routes.ts"), "export function getOrder() { return \"accepted\" }\n", "utf-8")
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
    appendRepublicSchedulerQueueRecord(repository!, {
      queueType: "seat-response",
      status: "queued",
      reason: "manager_unavailable",
      deliberationID: "large project",
      phase: "cross-examination",
      sourceMessageID: "house-2-r1-question",
      sourceMessageType: "question",
      targetSeatID: "planner-house-1",
      requestedAgent: "sisyphus",
      files: ["src/api/routes.ts"],
      summary: "Queue planner-house-1 for UI contract drift response.",
    })
    writeRepublicContract(repository!, {
      workgroupID: "api-workgroup",
      title: "API Contract",
      authorSeatID: "api-planner-seat",
      files: ["src/api/routes.ts"],
      content: "The API must expose getOrder and \"accepted\".",
    })
    initializeRepublicTeam(repository!, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "api-planner-seat",
            role: "planner",
            phase: "planning",
            workgroupID: "api-workgroup",
            module: "api",
            runtimeAgent: "general",
            reason: "API files were part of the goal.",
          },
          {
            seatID: "republic-supervisor",
            role: "supervisor",
            phase: "planning",
            runtimeAgent: "hephaestus",
          },
        ],
      },
      phase: {
        phase: "planning",
        status: "in-progress",
        deliberationID: "large-project",
        activeRound: 1,
        lockedContracts: ["api-workgroup"],
      },
    })

    const data = buildRepublicDashboardData({ directory, deliberationId: "large project" })

    expect(data.repository?.repoRoot).toBe(directory.replace(/\\/g, "/"))
    expect(data.teamManifest?.teamModel).toBe("parliament_squad")
    expect(data.teamPhase?.phase).toBe("planning")
    expect(data.seatStates.some((state) => state.seatID === "api-planner-seat")).toBe(true)
    expect(data.report.commons.messageCount).toBe(2)
    expect(data.schedulerQueueRecords).toHaveLength(1)
    expect(data.report.schedulerQueue.pending).toBe(1)
    expect(data.report.schedulerQueue.queued).toBe(1)
    expect(data.report.contractTraceability.contractCount).toBe(1)
    expect(data.report.contractTraceability.warningCount).toBe(0)
    expect(data.nodes.some((node) => node.id === "phase:planning")).toBe(true)
    expect(data.edges.some((edge) => edge.type === "team-seat")).toBe(true)
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
    expect(html).toContain("Governance Snapshot")
    expect(html).toContain("Command Board")
    expect(html).toContain("Commons Timeline")
    expect(html).toContain("team-board")
    expect(html).toContain('id="timeline"')
    expect(html).toContain("renderTimeline(data)")
    expect(html).toContain("Seat Inspector")
    expect(html).toContain("Seat Definition")
    expect(html).toContain("Current State")
    expect(html).toContain("Runtime Mapping")
    expect(html).toContain("allocation")
    expect(html).toContain("lang-select")
    expect(html).toContain("中文")
    expect(html).toContain("日本語")
    expect(html).toContain("한국어")
    expect(html).toContain("data-phase-filter")
    expect(html).toContain("data-metric-group")
    expect(html).toContain("maxParallel")
    expect(html).toContain("renderMessageDetails")
    expect(html).toContain("Contract Traceability")
    expect(html).toContain("Scheduler Queue")
    expect(html).not.toContain('id="graph"')
    expect(html).not.toContain("renderGraph")
    expect(html).not.toContain("Legacy all-edge graph renderer")
    expect(html).not.toContain("鈥")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("renders live dashboard html that polls data json", () => {
    const data = buildRepublicDashboardData({ directory })
    const html = renderRepublicDashboardHtml(data, { live: true, refreshMs: 500 })

    expect(html).toContain('fetch("/data.json"')
    expect(html).toContain("setInterval(render, 500)")
  })

  test("shows awaiting closure when phase is open but seats and queue are idle", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "ui-review-seat",
            role: "reviewer",
            phase: "review",
            workgroupID: "ui-workgroup",
            module: "src/ui",
          },
        ],
      },
      phase: {
        phase: "review",
        status: "in-progress",
        deliberationID: "snake-review",
        activeRound: 1,
      },
    })

    const html = renderRepublicDashboardHtml(buildRepublicDashboardData({ directory }))

    expect(html).toContain("idle, awaiting closure")
    expect(html).toContain("No seat or scheduler work is active")
  })

  test("starts a live dashboard server for an existing git repository", async () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const server = startRepublicDashboardServer({ directory, port: 0, refreshMs: 500 })
    expect(server).not.toBeNull()
    try {
      const response = await fetch(`${server!.url}/data.json`)
      const data = await response.json()
      expect(response.ok).toBe(true)
      expect(data.repository.repoRoot).toBe(directory.replace(/\\/g, "/"))
    } finally {
      server?.stop()
    }
  })

  test("resolves OS dashboard open commands", () => {
    expect(getDashboardOpenCommand("file.html", "win32")).toEqual({
      command: "cmd.exe",
      args: ["/c", "start", "", "file.html"],
    })
    expect(getDashboardOpenCommand("file.html", "darwin")).toEqual({
      command: "open",
      args: ["file.html"],
    })
    expect(getDashboardOpenCommand("file.html", "linux")).toEqual({
      command: "xdg-open",
      args: ["file.html"],
    })
    expect(getDashboardOpenCommand("file.html", "sunos")).toBeNull()
  })
})
