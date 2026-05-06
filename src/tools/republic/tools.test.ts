/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { BackgroundTask } from "../../features/background-agent"
import {
  appendRepublicCommonsMessage,
  getNativeGitRepository,
  getRepublicAgentDocPath,
  getRepublicContractPath,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  readRepublicSchedulerQueueRecords,
  readRepublicSeatState,
  readRepublicTeamManifest,
  readRepublicTeamPhase,
} from "../../shared/git-worktree"
import { createRepublicTools } from "./tools"

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
    "user.name=Republic Tool Test",
    "-c",
    "user.email=republic-tool@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  ])
}

function createToolContext(directory: string): ToolContext {
  return {
    sessionID: "ses_republic_tools",
    messageID: "msg_republic_tools",
    agent: "sisyphus",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function createDispatchManager(launched: Array<{ agent: string; prompt: string; description: string }>) {
  return {
    async launch(input: { agent: string; prompt: string; description: string }): Promise<BackgroundTask> {
      launched.push({
        agent: input.agent,
        prompt: input.prompt,
        description: input.description,
      })
      return {
        id: `bg_${launched.length}`,
        status: "pending",
        parentSessionId: "ses_republic_tools",
        parentMessageId: "msg_republic_tools",
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
      }
    },
  }
}

function createPluginInputWithAgents(directory: string, agents: Array<{ name: string; mode?: "subagent" | "primary" | "all" }>): PluginInput {
  return {
    directory,
    client: {
      app: {
        agents: async () => ({ data: agents }),
      },
    },
  } as unknown as PluginInput
}

describe("republic tools", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-tools-"))
    initRepo(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("publishes targeted commons messages and reads inbox", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Can API publish the response contract before implementation?",
      author_seat_id: "docs-seat",
      target_seat_id: "api-seat",
      workgroup_id: "wg-src-api",
      module: "src/api",
      files: ["src/api/orders.ts"],
    }, context)
    const inboxResult = await tools.republic_inbox.execute({
      seat_id: "api-seat",
      include_agent_doc: true,
    }, context)

    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")
    const ledger = readRepublicLedgerRecords(repository, "session-ses_republic_tools")

    expect(JSON.parse(String(publishResult)).message_type).toBe("question")
    expect(String(inboxResult)).toContain("Can API publish")
    expect(messages).toHaveLength(1)
    expect(ledger).toHaveLength(1)
    expect(existsSync(getRepublicAgentDocPath(repository, "api-seat"))).toBe(true)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("initializes a dynamic republic team under the git common dir", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const result = await tools.republic_team_init.execute({
      goal: "Build order API with database, tests, and docs",
      files: ["src/api/orders.ts", "src/db/orders.ts", "tests/orders.test.ts", "docs/orders.md"],
      deliberation_id: "order-system-team",
      team_model: "parliament_squad",
      seat_allocation: "auto",
    }, context)

    const parsed = JSON.parse(String(result))
    const repository = getNativeGitRepository(directory)!
    const manifest = readRepublicTeamManifest(repository)!
    const phase = readRepublicTeamPhase(repository)!
    const apiState = readRepublicSeatState(repository, "api-planner-seat")!
    const messages = readRepublicCommonsMessages(repository, "order-system-team")
    const ledger = readRepublicLedgerRecords(repository, "order-system-team")

    expect(parsed.ok).toBe(true)
    expect(parsed.team_model).toBe("parliament_squad")
    expect(parsed.seats.length).toBeGreaterThan(3)
    expect(manifest.seats.map((seat) => seat.seatID)).toContain("api-planner-seat")
    expect(phase.phase).toBe("planning")
    expect(phase.deliberationID).toBe("order-system-team")
    expect(apiState.status).toBe("standby")
    expect(apiState.workgroupID).toBe("api-workgroup")
    expect(messages[0]?.channel).toBe("team")
    expect(ledger[0]?.phase).toBe("team-init")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("updates seat state and reads team status", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    await tools.republic_team_init.execute({
      goal: "Build order API with database, tests, and docs",
      files: ["src/api/orders.ts", "src/db/orders.ts", "tests/orders.test.ts", "docs/orders.md"],
      deliberation_id: "order-system-team",
      team_model: "parliament_squad",
      seat_allocation: "auto",
    }, context)

    const updateResult = await tools.republic_seat_update.execute({
      seat_id: "api-planner-seat",
      status: "waiting",
      phase: "planning",
      workgroup_id: "api-workgroup",
      module: "api",
      task_id: "contract-api-v1",
      waiting_on: ["data-planner-seat"],
      memory: "Waiting for data-seat to confirm order table shape before locking API contract.",
      deliberation_id: "order-system-team",
    }, context)
    const statusResult = await tools.republic_team_status.execute({
      seat_id: "api-planner-seat",
      deliberation_id: "order-system-team",
      include_memory: true,
      limit: 5,
    }, context)

    const parsedUpdate = JSON.parse(String(updateResult))
    const parsedStatus = JSON.parse(String(statusResult))
    const repository = getNativeGitRepository(directory)!
    const state = readRepublicSeatState(repository, "api-planner-seat")!
    const messages = readRepublicCommonsMessages(repository, "order-system-team")
    const ledger = readRepublicLedgerRecords(repository, "order-system-team")

    expect(parsedUpdate.ok).toBe(true)
    expect(parsedUpdate.waiting_on).toEqual(["data-planner-seat"])
    expect(state.status).toBe("waiting")
    expect(state.waitingOn).toEqual(["data-planner-seat"])
    expect(parsedStatus.ok).toBe(true)
    expect(parsedStatus.seats).toHaveLength(1)
    expect(parsedStatus.seats[0].state.status).toBe("waiting")
    expect(parsedStatus.seats[0].memory).toContain("Waiting for data-seat")
    expect(messages.map((message) => message.phase)).toContain("seat-update")
    expect(ledger.map((record) => record.phase)).toContain("seat-update")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("updates team phase and locks contracts", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    await tools.republic_team_init.execute({
      goal: "Build order API with database, tests, and docs",
      files: ["src/api/orders.ts", "src/db/orders.ts", "tests/orders.test.ts", "docs/orders.md"],
      deliberation_id: "order-system-team",
      team_model: "parliament_squad",
      seat_allocation: "auto",
    }, context)

    const result = await tools.republic_phase_update.execute({
      phase: "execution",
      status: "in-progress",
      deliberation_id: "order-system-team",
      active_round: 2,
      locked_contracts: ["api-workgroup"],
      blocked_by: [],
      author_seat_id: "republic-supervisor",
      reason: "Planning consensus is locked; executor seats can implement against api-workgroup.",
    }, context)

    const parsed = JSON.parse(String(result))
    const repository = getNativeGitRepository(directory)!
    const phase = readRepublicTeamPhase(repository)!
    const messages = readRepublicCommonsMessages(repository, "order-system-team")
    const ledger = readRepublicLedgerRecords(repository, "order-system-team")

    expect(parsed.ok).toBe(true)
    expect(parsed.phase).toBe("execution")
    expect(parsed.locked_contracts).toEqual(["api-workgroup"])
    expect(phase.phase).toBe("execution")
    expect(phase.status).toBe("in-progress")
    expect(phase.activeRound).toBe(2)
    expect(phase.lockedContracts).toEqual(["api-workgroup"])
    expect(messages.map((message) => message.phase)).toContain("phase-update")
    expect(ledger.map((record) => record.phase)).toContain("phase-update")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("starts an active collaboration round for dynamic seats", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools({ directory } as PluginInput, {
      manager: createDispatchManager(launched),
    })
    const context = createToolContext(directory)

    await tools.republic_team_init.execute({
      goal: "Build order API with database, tests, and docs",
      files: ["src/api/orders.ts", "src/db/orders.ts", "tests/orders.test.ts", "docs/orders.md"],
      deliberation_id: "order-system-team",
      team_model: "parliament_squad",
      seat_allocation: "auto",
    }, context)

    const result = await tools.republic_round_start.execute({
      goal: "Each planning seat should propose its contract risks and ask adjacent seats about unclear boundaries.",
      phase: "planning",
      deliberation_id: "order-system-team",
      max_seats: 3,
      round: 1,
    }, context)

    const parsed = JSON.parse(String(result))
    const repository = getNativeGitRepository(directory)!
    const phase = readRepublicTeamPhase(repository)!
    const apiState = readRepublicSeatState(repository, "api-planner-seat")!
    const messages = readRepublicCommonsMessages(repository, "order-system-team")
    const ledger = readRepublicLedgerRecords(repository, "order-system-team")

    expect(parsed.ok).toBe(true)
    expect(parsed.phase).toBe("planning")
    expect(parsed.round).toBe(1)
    expect(parsed.dispatches.length).toBeGreaterThan(1)
    expect(launched.length).toBe(parsed.dispatches.length)
    expect(launched[0]?.description).toContain("Republic planning round 1")
    expect(launched[0]?.prompt).toContain("republic_team_status")
    expect(launched[0]?.prompt).toContain("republic_publish")
    expect(launched[0]?.prompt).toContain("republic_seat_update")
    expect(launched[0]?.prompt).toContain("Preserve exact field names")
    expect(launched[0]?.prompt).toContain("quote the exact objective/contract terms")
    expect(launched[0]?.prompt).toContain("Work in one bounded step at a time")
    expect(launched[0]?.prompt).toContain("Do not create or update dependencies")
    expect(launched[0]?.prompt).toContain("Do not edit project files")
    expect(phase.activeRound).toBe(1)
    expect(apiState.status).toBe("running")
    expect(messages.map((message) => message.phase)).toContain("round-dispatch")
    expect(ledger.map((record) => record.phase)).toContain("round-dispatch")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("injects locked contract excerpts into execution seats", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools({ directory } as PluginInput, {
      manager: createDispatchManager(launched),
    })
    const context = createToolContext(directory)

    await tools.republic_team_init.execute({
      goal: "Build order API with tests and docs",
      files: ["src/api/orders.ts", "tests/orders.test.ts", "docs/orders.md"],
      deliberation_id: "order-contract-team",
      team_model: "parliament_squad",
      seat_allocation: "auto",
    }, context)
    await tools.republic_contract.execute({
      title: "API Contract v1",
      content: "OrderRequest must use discountCode?: string and accepted responses include shipmentEvents: [].",
      author_seat_id: "api-planner-seat",
      workgroup_id: "api-workgroup",
      deliberation_id: "order-contract-team",
      status: "accepted",
    }, context)
    await tools.republic_phase_update.execute({
      phase: "execution",
      status: "in-progress",
      deliberation_id: "order-contract-team",
      locked_contracts: ["api-workgroup.md"],
    }, context)

    const repository = getNativeGitRepository(directory)!
    const contractPath = getRepublicContractPath(repository, "api-workgroup")
    const statusResult = await tools.republic_team_status.execute({
      deliberation_id: "order-contract-team",
      include_memory: true,
    }, context)
    const status = JSON.parse(String(statusResult))
    expect(status.locked_contracts[0]).toMatchObject({
      id: "api-workgroup",
      path: contractPath,
      found: true,
    })
    expect(status.locked_contracts[0]?.content).toContain("discountCode?: string")
    const inboxResult = await tools.republic_inbox.execute({
      seat_id: "api-executor-seat",
      deliberation_id: "order-contract-team",
      include_agent_doc: true,
    }, context)
    expect(String(inboxResult)).toContain("## Current Phase")
    expect(String(inboxResult)).toContain("## Locked Contracts")
    expect(String(inboxResult)).toContain("discountCode?: string")
    expect(String(inboxResult)).toContain("Do not invent substitute field names")

    await tools.republic_round_start.execute({
      goal: "Implement the locked order API contract.",
      phase: "execution",
      deliberation_id: "order-contract-team",
      seat_ids: ["api-executor-seat"],
      max_seats: 1,
      round: 2,
    }, context)

    expect(launched).toHaveLength(1)
    expect(launched[0]?.prompt).toContain("Locked contract files live under the Git common dir")
    expect(launched[0]?.prompt).toContain(contractPath)
    expect(launched[0]?.prompt).toContain("discountCode?: string")
    expect(launched[0]?.prompt).toContain("if another workgroup is needed")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("reserves a round slot for supervisor when requested", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools({ directory } as PluginInput, {
      manager: createDispatchManager(launched),
    })
    const context = createToolContext(directory)

    await tools.republic_team_init.execute({
      goal: "Build order API with database, tests, and docs",
      files: ["src/api/orders.ts", "src/db/orders.ts", "tests/orders.test.ts", "docs/orders.md"],
      deliberation_id: "order-system-team",
      team_model: "parliament_squad",
      seat_allocation: "auto",
    }, context)

    const result = await tools.republic_round_start.execute({
      goal: "Execution seats implement while supervisor watches blockers.",
      phase: "execution",
      deliberation_id: "order-system-team",
      include_supervisor: true,
      max_seats: 3,
      round: 2,
    }, context)

    const parsed = JSON.parse(String(result))
    const dispatchedSeats = parsed.dispatches.map((dispatch: { seat_id: string }) => dispatch.seat_id)

    expect(parsed.ok).toBe(true)
    expect(parsed.dispatches).toHaveLength(3)
    expect(dispatchedSeats).toContain("republic-supervisor")
    expect(dispatchedSeats.filter((seatID: string) => seatID.endsWith("-executor-seat"))).toHaveLength(2)
    expect(launched).toHaveLength(3)
    expect(launched.some((launch) => launch.prompt.includes('persistent Republic seat "republic-supervisor"'))).toBe(true)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("resolves repository from tool context when plugin input directory is unavailable", async () => {
    const tools = createRepublicTools({} as PluginInput)
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Can docs confirm the shared contract?",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
    }, context)

    expect(JSON.parse(String(publishResult)).ok).toBe(true)
    expect(readRepublicCommonsMessages(getNativeGitRepository(directory)!, "session-ses_republic_tools")).toHaveLength(1)
  })

  test("auto-dispatches targeted questions to a background seat", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools({ directory } as PluginInput, {
      manager: createDispatchManager(launched),
      config: {
        enabled: true,
        mode: "advisory",
        ledger: true,
        house_seats: 3,
        senate_seats: 2,
        review_bench_seats: 2,
        quorum: 4,
        supermajority: 0.67,
        veto_on_blocker: true,
        git_summary: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 6,
          agent_docs: true,
        },
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
        contracts: {
          enabled: true,
        },
        scheduler: {
          enabled: true,
          auto_dispatch: true,
          message_types: ["question", "handoff", "objection"],
          default_agent: "sisyphus",
          supervisor_agent: "hephaestus",
          seat_agents: {
            "docs-seat": "hephaestus",
          },
          prompt_max_messages: 8,
        },
      },
    })
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Please confirm the order response enum values.",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      workgroup_id: "wg-src-api",
      module: "src/api",
      files: ["src/api/orders.ts"],
    }, context)

    const parsed = JSON.parse(String(publishResult))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")
    const ledger = readRepublicLedgerRecords(repository, "session-ses_republic_tools")
    const queue = readRepublicSchedulerQueueRecords(repository, "session-ses_republic_tools")

    expect(parsed.dispatch).toEqual({ taskID: "bg_1", agent: "hephaestus" })
    expect(parsed.queued_dispatch).toBeUndefined()
    expect(launched).toHaveLength(1)
    expect(launched[0]?.prompt).toContain('author_seat_id="docs-seat"')
    expect(launched[0]?.prompt).toContain('references=["session-ses_republic_tools-api-seat-question')
    expect(messages.map((message) => message.channel)).toEqual(["commons", "scheduler"])
    expect(messages[1]?.references).toEqual([messages[0]?.messageID])
    expect(ledger.map((record) => record.phase)).toEqual(["collaboration", "dispatch"])
    expect(queue).toHaveLength(1)
    expect(queue[0]?.status).toBe("dispatched")
    expect(queue[0]?.targetSeatID).toBe("docs-seat")
    expect(queue[0]?.requestedAgent).toBe("hephaestus")
    expect(queue[0]?.runtimeAgent).toBe("hephaestus")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("queues targeted messages when no background manager is available", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Can test-seat confirm the rollback boundary?",
      author_seat_id: "api-seat",
      target_seat_id: "test-seat",
      deliberation_id: "queued-response",
      target_agent: "sisyphus",
    }, context)

    const parsed = JSON.parse(String(publishResult))
    const repository = getNativeGitRepository(directory)!
    const queue = readRepublicSchedulerQueueRecords(repository, "queued-response")

    expect(parsed.dispatch).toBeUndefined()
    expect(parsed.queued_dispatch.target_seat_id).toBe("test-seat")
    expect(parsed.queued_dispatch.requested_agent).toBe("sisyphus")
    expect(parsed.queued_dispatch.reason).toBe("manager_unavailable")
    expect(queue).toHaveLength(1)
    expect(queue[0]?.queueType).toBe("seat-response")
    expect(queue[0]?.status).toBe("queued")
    expect(queue[0]?.targetSeatID).toBe("test-seat")
    expect(queue[0]?.requestedAgent).toBe("sisyphus")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("falls back to a registered runtime agent for scheduler dispatch", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools(createPluginInputWithAgents(directory, [
      { name: "general", mode: "subagent" },
      { name: "explore", mode: "subagent" },
    ]), {
      manager: createDispatchManager(launched),
      config: {
        enabled: true,
        mode: "advisory",
        ledger: true,
        house_seats: 3,
        senate_seats: 2,
        review_bench_seats: 2,
        quorum: 4,
        supermajority: 0.67,
        veto_on_blocker: true,
        git_summary: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 6,
          agent_docs: true,
        },
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
        contracts: {
          enabled: true,
        },
        scheduler: {
          enabled: true,
          auto_dispatch: true,
          message_types: ["question", "handoff", "objection"],
          default_agent: "sisyphus",
          supervisor_agent: "hephaestus",
          seat_agents: {
            "docs-seat": "hephaestus",
          },
          prompt_max_messages: 8,
        },
      },
    })
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Please confirm the public docs shape.",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      workgroup_id: "wg-src-api",
    }, context)

    const parsed = JSON.parse(String(publishResult))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")
    const queue = readRepublicSchedulerQueueRecords(repository, "session-ses_republic_tools")

    expect(parsed.dispatch).toEqual({ taskID: "bg_1", agent: "general", requested_agent: "hephaestus" })
    expect(launched[0]?.agent).toBe("general")
    expect(launched[0]?.prompt).toContain('Requested OMO role: "hephaestus"')
    expect(launched[0]?.prompt).toContain('Runtime OpenCode agent: "general"')
    expect(messages[1]?.content).toContain("via general (requested hephaestus)")
    expect(queue[0]?.status).toBe("dispatched")
    expect(queue[0]?.requestedAgent).toBe("hephaestus")
    expect(queue[0]?.runtimeAgent).toBe("general")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("dispatches supervisor review for objections", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools(createPluginInputWithAgents(directory, [
      { name: "general", mode: "subagent" },
    ]), {
      manager: createDispatchManager(launched),
      config: {
        enabled: true,
        mode: "advisory",
        ledger: true,
        house_seats: 3,
        senate_seats: 2,
        review_bench_seats: 2,
        quorum: 4,
        supermajority: 0.67,
        veto_on_blocker: true,
        git_summary: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 6,
          agent_docs: true,
        },
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
        contracts: {
          enabled: true,
        },
        scheduler: {
          enabled: true,
          auto_dispatch: true,
          message_types: ["question", "handoff", "objection"],
          default_agent: "sisyphus",
          supervisor_agent: "hephaestus",
          seat_agents: {},
          prompt_max_messages: 8,
        },
      },
    })
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "objection",
      content: "Docs and API disagree on whether status should be numeric.",
      author_seat_id: "docs-seat",
      deliberation_id: "api-status-contract",
      workgroup_id: "wg-src-api",
      status: "blocked",
      references: ["api-status-proposal"],
    }, context)

    const parsed = JSON.parse(String(publishResult))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "api-status-contract")
    const ledger = readRepublicLedgerRecords(repository, "api-status-contract")
    const queue = readRepublicSchedulerQueueRecords(repository, "api-status-contract")

    expect(parsed.dispatch).toBeUndefined()
    expect(parsed.supervisor_dispatch).toEqual({ taskID: "bg_1", agent: "general", requested_agent: "hephaestus" })
    expect(parsed.queued_supervisor_dispatch).toBeUndefined()
    expect(launched).toHaveLength(1)
    expect(launched[0]?.description).toContain("Republic supervisor review")
    expect(launched[0]?.prompt).toContain('author_seat_id="republic-supervisor"')
    expect(launched[0]?.prompt).toContain('message_type="consensus" or "revision" or "objection"')
    expect(messages.map((message) => message.phase)).toEqual(["collaboration", "supervisor-dispatch"])
    expect(messages[1]?.targetSeatID).toBe("republic-supervisor")
    expect(messages[1]?.references).toEqual([messages[0]?.messageID])
    expect(ledger.map((record) => record.phase)).toEqual(["collaboration", "supervisor-dispatch"])
    expect(queue).toHaveLength(1)
    expect(queue[0]?.queueType).toBe("supervisor-review")
    expect(queue[0]?.status).toBe("dispatched")
    expect(queue[0]?.targetSeatID).toBe("republic-supervisor")
    expect(queue[0]?.runtimeAgent).toBe("general")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("waits for a referenced republic response", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)
    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Should the public status be a string enum?",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      deliberation_id: "status-enum-wait",
    }, context)
    const messageID = JSON.parse(String(publishResult)).message_id as string
    const repository = getNativeGitRepository(directory)!

    setTimeout(() => {
      appendRepublicCommonsMessage(repository, {
        deliberationID: "status-enum-wait",
        channel: "commons",
        phase: "collaboration",
        authorSeatID: "docs-seat",
        targetSeatID: "api-seat",
        messageType: "answer",
        references: [messageID],
        content: "Use a string enum for public status.",
      })
    }, 25)

    const waitResult = await tools.republic_wait.execute({
      message_id: messageID,
      deliberation_id: "status-enum-wait",
      timeout_ms: 1000,
      poll_interval_ms: 25,
    }, context)

    const parsed = JSON.parse(String(waitResult))
    expect(parsed.ok).toBe(true)
    expect(parsed.responses).toHaveLength(1)
    expect(parsed.responses[0].message_type).toBe("answer")
    expect(parsed.responses[0].content).toContain("string enum")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("times out when no referenced republic response appears", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const waitResult = await tools.republic_wait.execute({
      message_id: "missing-message",
      deliberation_id: "status-enum-wait",
      timeout_ms: 100,
      poll_interval_ms: 25,
    }, context)

    const parsed = JSON.parse(String(waitResult))
    expect(parsed.ok).toBe(false)
    expect(parsed.timeout).toBe(true)
    expect(parsed.message_id).toBe("missing-message")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("writes workgroup contracts and publishes contract messages", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const result = await tools.republic_contract.execute({
      workgroup_id: "wg-src-api",
      title: "Order cancellation response",
      content: "API returns id, status, and cancellationReason.",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      module: "src/api",
      status: "proposed",
      files: ["src/api/orders.ts", "docs/api/orders.md"],
    }, context)

    const parsed = JSON.parse(String(result))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")

    expect(parsed.ok).toBe(true)
    expect(readFileSync(getRepublicContractPath(repository, "wg-src-api"), "utf-8")).toContain("Order cancellation response")
    expect(messages[0]?.messageType).toBe("contract")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
