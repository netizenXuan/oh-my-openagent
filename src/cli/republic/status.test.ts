/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendNativeGitAuditRecord, appendRepublicLedgerRecord, getNativeGitRepository } from "../../shared/git-worktree"
import { buildRepublicStatusReport, formatRepublicStatusReport } from "./status"

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
    "user.name=Republic Status Test",
    "-c",
    "user.email=republic-status@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    message,
  ])
}

describe("republic status report", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-status-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("reports no repository outside git", () => {
    const report = buildRepublicStatusReport({ directory })

    expect(report.repository).toBeNull()
    expect(report.republic.recordCount).toBe(0)
    expect(formatRepublicStatusReport(report)).toContain("Not inside a git repository")
  })

  test("combines republic ledger and native git audit summaries", () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    appendRepublicLedgerRecord(repository!, {
      deliberationID: "native git republic",
      phase: "seat-proposal",
      chamber: "house",
      seatID: "planner-house-1",
      role: "planner",
      agent: "prometheus",
      vote: "approve",
      confidence: 0.75,
      files: ["README.md"],
      summary: "Proceed with tracked native git.",
    })
    appendNativeGitAuditRecord(repository!, {
      tool: "edit",
      sessionID: "ses_1",
      callID: "call_1",
      agent: "atlas",
      model: "kimi-for-coding/k2p6",
      category: "quick",
      files: ["README.md"],
      summary: "README.md changed",
    })

    const report = buildRepublicStatusReport({
      directory,
      deliberationId: "native git republic",
    })
    const formatted = formatRepublicStatusReport(report)

    expect(report.repository?.repoRoot).toBe(directory.replace(/\\/g, "/"))
    expect(report.republic.recordCount).toBe(1)
    expect(report.republic.deliberationID).toBe("native-git-republic")
    expect(report.decision.status).toBe("needs-quorum")
    expect(report.nativeGit.recordCount).toBe(1)
    expect(formatted).toContain("OMO Republic Status")
    expect(formatted).toContain("Deliberations: native-git-republic")
    expect(formatted).toContain("Agents: prometheus=1")
    expect(formatted).toContain("Decision: needs-quorum")
    expect(formatted).toContain("Models: kimi-for-coding/k2p6=1")
    expect(formatted).toContain("Next action:")
  })
})
