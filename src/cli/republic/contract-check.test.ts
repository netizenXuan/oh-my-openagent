/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository, writeRepublicContract } from "../../shared/git-worktree"
import {
  buildRepublicContractCheckReport,
  formatRepublicContractCheckReport,
  republicContractCheck,
} from "./contract-check"

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
    "user.name=Republic Contract Check Test",
    "-c",
    "user.email=republic-contract-check@example.test",
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

describe("republic contract check", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-contract-check-"))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("passes strict mode when contract terms are covered", async () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "orders.ts"), [
      'export type OrderStatus = "pending" | "delivered"',
      "export function deliverOrder() { return \"delivered\" }",
      "",
    ].join("\n"), "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    writeRepublicContract(repository!, {
      workgroupID: "api-workgroup",
      title: "Delivery contract",
      authorSeatID: "api-seat",
      files: ["orders.ts"],
      content: "Implementation must expose OrderStatus, deliverOrder, and \"delivered\".",
    })

    const report = buildRepublicContractCheckReport({ directory, strict: true })
    const formatted = formatRepublicContractCheckReport(report)

    expect(report.passed).toBe(true)
    expect(report.traceability.warningCount).toBe(0)
    expect(formatted).toContain("Result: pass")
    expect(await silenceConsole(() => republicContractCheck({ directory, strict: true }))).toBe(0)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("fails strict mode when hard contract terms are missing", async () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "orders.ts"), 'export const status = "pending"\n', "utf-8")
    commitAll(directory, "init")

    const repository = getNativeGitRepository(directory)
    expect(repository).not.toBeNull()
    writeRepublicContract(repository!, {
      workgroupID: "api-workgroup",
      title: "Delivery contract",
      authorSeatID: "api-seat",
      files: ["orders.ts"],
      content: "Implementation must expose deliverOrder and \"delivered\".",
    })

    const report = buildRepublicContractCheckReport({ directory, strict: true })

    expect(report.passed).toBe(false)
    expect(report.traceability.warningCount).toBe(1)
    expect(report.traceability.items[0]?.uncoveredTerms).toContain("deliverOrder")
    expect(await silenceConsole(() => republicContractCheck({ directory, strict: true, json: true }))).toBe(1)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("writes json output without dirtying the inspected repository", async () => {
    git(directory, ["init"])
    writeFileSync(join(directory, "README.md"), "hello\n", "utf-8")
    commitAll(directory, "init")

    const output = join(directory, "..", "contract-check.json")
    const exitCode = await republicContractCheck({
      directory,
      output,
      json: true,
    })

    expect(exitCode).toBe(0)
    expect(existsSync(output)).toBe(true)
    expect(readFileSync(output, "utf-8")).toContain('"contractCount": 0')
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
