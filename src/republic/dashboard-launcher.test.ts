/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RepublicConfigSchema } from "../config/schema"
import { getNativeGitRepository } from "../shared/git-worktree"
import { maybeOpenRepublicDashboard, stopRepublicDashboardServers } from "./dashboard-launcher"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd()
}

function initRepo(cwd: string): void {
  git(cwd, ["init"])
  writeFileSync(join(cwd, "README.md"), "hello\n", "utf-8")
  git(cwd, ["add", "."])
  git(cwd, [
    "-c",
    "user.name=Republic Dashboard Launcher Test",
    "-c",
    "user.email=republic-dashboard-launcher@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  ])
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port)
          return
        }
        reject(new Error("Could not allocate a test port"))
      })
    })
    server.on("error", reject)
  })
}

describe("republic dashboard launcher", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-dashboard-launcher-"))
    initRepo(directory)
  })

  afterEach(() => {
    stopRepublicDashboardServers()
    rmSync(directory, { recursive: true, force: true })
  })

  test("starts dashboard by default", async () => {
    const repository = getNativeGitRepository(directory)!
    const port = await getFreePort()
    const config = RepublicConfigSchema.parse({})
    config.dashboard.port = port

    const result = maybeOpenRepublicDashboard({
      repository,
      config,
      event: "team_init",
      deliberationID: "team",
      opener: () => true,
    })

    expect(result.opened).toBe(true)
    expect(result.reason).toBe("started")
  })

  test("does not open dashboard when auto open is explicitly disabled", () => {
    const repository = getNativeGitRepository(directory)!
    const config = RepublicConfigSchema.parse({
      dashboard: {
        auto_open: false,
      },
    })

    const result = maybeOpenRepublicDashboard({
      repository,
      config,
      event: "team_init",
      deliberationID: "team",
      opener: () => true,
    })

    expect(result).toEqual({ opened: false, reason: "disabled" })
  })

  test("starts dashboard when auto open is enabled for the event", async () => {
    const repository = getNativeGitRepository(directory)!
    const port = await getFreePort()
    const config = RepublicConfigSchema.parse({
      dashboard: {
        auto_open: true,
        auto_open_events: ["team_init"],
        port,
        refresh_ms: 500,
      },
    })

    const result = maybeOpenRepublicDashboard({
      repository,
      config,
      event: "team_init",
      deliberationID: "team",
      opener: () => true,
    })

    expect(result.opened).toBe(true)
    expect(result.reason).toBe("started")
    expect(result.url).toContain("http://127.0.0.1:")
    const response = await fetch(`${result.url}/data.json`)
    expect(response.ok).toBe(true)
  })
})
