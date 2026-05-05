/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getNativeGitRepository } from "./native-git"
import {
  appendRepublicSeatMemory,
  getRepublicSeatMemoryPath,
  getRepublicSeatStatePath,
  getRepublicTeamManifestPath,
  getRepublicTeamPhasePath,
  initializeRepublicTeam,
  readRepublicSeatMemory,
  readRepublicSeatState,
  readRepublicTeamManifest,
  readRepublicTeamPhase,
  writeRepublicSeatState,
} from "./republic-team"

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
    "user.name=Republic Team Test",
    "-c",
    "user.email=republic-team@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  ])
}

describe("republic team state", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-team-"))
    initRepo(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("initializes manifest, phase, seat state, and memory under git common dir", () => {
    const repository = getNativeGitRepository(directory)!

    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "API Seat!",
            role: "planner-executor",
            phase: "planning",
            workgroupID: "api-workgroup",
            module: "src/api",
            runtimeAgent: "general",
            conceptualAgent: "atlas",
            reason: "API routes are in scope.",
          },
        ],
      },
      phase: {
        phase: "planning",
        status: "in-progress",
        deliberationID: "order-system",
        activeRound: 0,
      },
    })

    const manifest = readRepublicTeamManifest(repository)!
    const phase = readRepublicTeamPhase(repository)!
    const state = readRepublicSeatState(repository, "API Seat!")!
    const memory = readRepublicSeatMemory(repository, "API Seat!")

    expect(getRepublicTeamManifestPath(repository)).toContain(join(".git", "omo", "republic", "team", "manifest.json"))
    expect(getRepublicTeamPhasePath(repository)).toContain(join(".git", "omo", "republic", "team", "phase.json"))
    expect(getRepublicSeatStatePath(repository, "API Seat!")).toContain(join(".git", "omo", "republic", "team", "seats", "API-Seat", "state.json"))
    expect(getRepublicSeatMemoryPath(repository, "API Seat!")).toContain(join(".git", "omo", "republic", "team", "seats", "API-Seat", "memory.md"))
    expect(manifest.seats[0]?.seatID).toBe("API-Seat")
    expect(phase.deliberationID).toBe("order-system")
    expect(state.status).toBe("standby")
    expect(state.workgroupID).toBe("api-workgroup")
    expect(memory).toContain("API routes are in scope.")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("updates seat state and appends durable memory without dirtying the worktree", () => {
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "squad",
        seatAllocation: "count",
        maxParallelSeats: 2,
        defaultRuntimeAgent: "general",
        seats: [{ seatID: "test-seat", role: "reviewer", phase: "review" }],
      },
    })

    writeRepublicSeatState(repository, {
      seatID: "test-seat",
      role: "reviewer",
      status: "waiting",
      phase: "review",
      waitingOn: ["api-seat"],
      lastMessageID: "msg-123",
      sessionID: "ses_123",
      lastSeenCommonsOffset: 42,
    })
    appendRepublicSeatMemory(repository, "test-seat", "Waiting on API contract answer.")

    const state = readRepublicSeatState(repository, "test-seat")!
    const memory = readRepublicSeatMemory(repository, "test-seat")

    expect(state.status).toBe("waiting")
    expect(state.waitingOn).toEqual(["api-seat"])
    expect(state.lastSeenCommonsOffset).toBe(42)
    expect(memory).toContain("Waiting on API contract answer.")
    expect(existsSync(getRepublicSeatStatePath(repository, "test-seat"))).toBe(true)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
