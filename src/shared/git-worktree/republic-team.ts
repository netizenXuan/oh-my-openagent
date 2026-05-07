import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { NativeGitRepository } from "./native-git"
import { sanitizeRepublicDeliberationID } from "./republic-ledger"

export type RepublicTeamPhase = "planning" | "execution" | "review" | "idle"
export type RepublicTeamStatus = "planned" | "in-progress" | "blocked" | "review" | "done"
export type RepublicSeatStatus = "standby" | "running" | "waiting" | "blocked" | "done" | "error"

export interface RepublicTeamSeatDefinition {
  seatID: string
  role: string
  phase?: RepublicTeamPhase
  workgroupID?: string
  module?: string
  taskID?: string
  runtimeAgent?: string
  conceptualAgent?: string
  reason?: string
}

export interface RepublicTeamManifest {
  version?: number
  timestamp?: string
  repoRoot?: string
  teamModel: string
  seatAllocation: string
  maxParallelSeats: number
  defaultRuntimeAgent: string
  seats: RepublicTeamSeatDefinition[]
}

export interface RepublicTeamPhaseState {
  version?: number
  timestamp?: string
  repoRoot?: string
  phase: RepublicTeamPhase
  status: RepublicTeamStatus
  deliberationID?: string
  activeRound?: number
  lockedContracts?: string[]
  blockedBy?: string[]
}

export interface RepublicSeatState {
  version?: number
  timestamp?: string
  repoRoot?: string
  seatID: string
  role?: string
  runtimeAgent?: string
  conceptualAgent?: string
  status: RepublicSeatStatus
  phase?: RepublicTeamPhase
  workgroupID?: string
  module?: string
  taskID?: string
  waitingOn?: string[]
  lastMessageID?: string
  sessionID?: string
  lastSeenCommonsOffset?: number
}

function writeJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function readJSON<T>(path: string): T | null {
  if (!existsSync(path)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")) as T
  } catch {
    return null
  }
}

function withMetadata<T extends object>(repository: NativeGitRepository, value: T): T & {
  version: number
  timestamp: string
  repoRoot: string
} {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    repoRoot: repository.repoRoot,
    ...value,
  }
}

export function getRepublicTeamDir(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "team")
}

export function getRepublicTeamManifestPath(repository: NativeGitRepository): string {
  return join(getRepublicTeamDir(repository), "manifest.json")
}

export function getRepublicTeamPhasePath(repository: NativeGitRepository): string {
  return join(getRepublicTeamDir(repository), "phase.json")
}

export function getRepublicSeatDir(repository: NativeGitRepository, seatID: string): string {
  return join(getRepublicTeamDir(repository), "seats", sanitizeRepublicDeliberationID(seatID))
}

export function getRepublicSeatStatePath(repository: NativeGitRepository, seatID: string): string {
  return join(getRepublicSeatDir(repository, seatID), "state.json")
}

export function getRepublicSeatMemoryPath(repository: NativeGitRepository, seatID: string): string {
  return join(getRepublicSeatDir(repository, seatID), "memory.md")
}

export function writeRepublicTeamManifest(
  repository: NativeGitRepository,
  manifest: RepublicTeamManifest,
): string {
  const path = getRepublicTeamManifestPath(repository)
  const normalizedSeats = manifest.seats.map((seat) => ({
    ...seat,
    seatID: sanitizeRepublicDeliberationID(seat.seatID),
  }))
  writeJSON(path, withMetadata(repository, {
    ...manifest,
    seats: normalizedSeats,
  }))
  return path
}

export function readRepublicTeamManifest(repository: NativeGitRepository): RepublicTeamManifest | null {
  return readJSON<RepublicTeamManifest>(getRepublicTeamManifestPath(repository))
}

export function writeRepublicTeamPhase(
  repository: NativeGitRepository,
  phase: RepublicTeamPhaseState,
): string {
  const path = getRepublicTeamPhasePath(repository)
  writeJSON(path, withMetadata(repository, phase))
  return path
}

export function readRepublicTeamPhase(repository: NativeGitRepository): RepublicTeamPhaseState | null {
  return readJSON<RepublicTeamPhaseState>(getRepublicTeamPhasePath(repository))
}

export function writeRepublicSeatState(
  repository: NativeGitRepository,
  state: RepublicSeatState,
): string {
  const path = getRepublicSeatStatePath(repository, state.seatID)
  writeJSON(path, withMetadata(repository, {
    ...state,
    seatID: sanitizeRepublicDeliberationID(state.seatID),
  }))
  return path
}

export function readRepublicSeatState(
  repository: NativeGitRepository,
  seatID: string,
): RepublicSeatState | null {
  return readJSON<RepublicSeatState>(getRepublicSeatStatePath(repository, seatID))
}

export function readRepublicSeatMemory(repository: NativeGitRepository, seatID: string): string {
  const path = getRepublicSeatMemoryPath(repository, seatID)
  if (!existsSync(path)) {
    return ""
  }
  return readFileSync(path, "utf-8")
}

export function appendRepublicSeatMemory(
  repository: NativeGitRepository,
  seatID: string,
  content: string,
): string {
  const path = getRepublicSeatMemoryPath(repository, seatID)
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, `# Republic Seat Memory: ${sanitizeRepublicDeliberationID(seatID)}\n\n`, "utf-8")
  }
  appendFileSync(path, `## ${new Date().toISOString()}\n\n${content.trim()}\n\n`, "utf-8")
  return path
}

export function initializeRepublicTeam(
  repository: NativeGitRepository,
  args: {
    manifest: RepublicTeamManifest
    phase?: RepublicTeamPhaseState
  },
): void {
  writeRepublicTeamManifest(repository, args.manifest)
  writeRepublicTeamPhase(repository, args.phase ?? {
    phase: "planning",
    status: "planned",
  })

  for (const seat of args.manifest.seats) {
    writeRepublicSeatState(repository, {
      seatID: seat.seatID,
      role: seat.role,
      runtimeAgent: seat.runtimeAgent,
      conceptualAgent: seat.conceptualAgent,
      status: "standby",
      phase: seat.phase,
      workgroupID: seat.workgroupID,
      module: seat.module,
      taskID: seat.taskID,
    })
    appendRepublicSeatMemory(
      repository,
      seat.seatID,
      [
        `Role: ${seat.role}`,
        seat.phase ? `Phase: ${seat.phase}` : undefined,
        seat.workgroupID ? `Workgroup: ${seat.workgroupID}` : undefined,
        seat.module ? `Module: ${seat.module}` : undefined,
        seat.reason ? `Allocation reason: ${seat.reason}` : undefined,
      ].filter(Boolean).join("\n"),
    )
  }
}
