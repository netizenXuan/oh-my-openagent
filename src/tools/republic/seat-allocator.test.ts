/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { RepublicConfig } from "../../config"
import { allocateRepublicTeam } from "./seat-allocator"

function createConfig(overrides: Partial<RepublicConfig> = {}): RepublicConfig {
  const base: RepublicConfig = {
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
    team_model: "advisory",
    team: {
      seat_allocation: "auto",
      seat_memory: true,
      persistent_sessions: true,
      planner_seat_count: "auto",
      executor_seat_count: "auto",
      reviewer_seat_count: 2,
      max_parallel_seats: 4,
      default_runtime_agent: "general",
    },
    seats: {
      planners: [],
      executors: [],
      reviewers: [],
      supervisors: ["republic-supervisor"],
    },
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
  }
  return {
    ...base,
    ...overrides,
    team: { ...base.team, ...overrides.team },
    seats: { ...base.seats, ...overrides.seats },
    scheduler: { ...base.scheduler, ...overrides.scheduler },
  }
}

describe("republic seat allocator", () => {
  test("infers task-specific seats from goal and files", () => {
    const manifest = allocateRepublicTeam({
      goal: "Build an order API with database schema, tests, and documentation",
      files: ["src/api/orders.ts", "src/db/order.ts", "tests/orders.test.ts", "docs/orders.md"],
      config: createConfig({
        team_model: "parliament_squad",
      }),
    })

    const seatIDs = manifest.seats.map((seat) => seat.seatID)

    expect(manifest.teamModel).toBe("parliament_squad")
    expect(manifest.seatAllocation).toBe("auto")
    expect(seatIDs).toContain("api-planner-seat")
    expect(seatIDs).toContain("data-planner-seat")
    expect(seatIDs).toContain("test-planner-seat")
    expect(seatIDs).toContain("api-executor-seat")
    expect(seatIDs).toContain("republic-supervisor")
    expect(manifest.seats.find((seat) => seat.seatID === "api-planner-seat")?.reason).toContain("API")
  })

  test("respects user-provided seat counts without requiring explicit roles", () => {
    const manifest = allocateRepublicTeam({
      goal: "Create a dashboard UI and CLI command",
      files: ["src/cli/dashboard.ts", "src/ui/Dashboard.tsx"],
      maxParallelSeats: 8,
      config: createConfig({
        team: {
          seat_allocation: "count",
          planner_seat_count: 5,
          executor_seat_count: 3,
          reviewer_seat_count: 1,
          seat_memory: true,
          persistent_sessions: true,
          max_parallel_seats: 4,
          default_runtime_agent: "general",
        },
      }),
    })

    expect(manifest.seatAllocation).toBe("count")
    expect(manifest.maxParallelSeats).toBe(8)
    expect(manifest.seats.filter((seat) => seat.phase === "planning")).toHaveLength(5)
    expect(manifest.seats.filter((seat) => seat.phase === "execution")).toHaveLength(3)
    expect(manifest.seats.filter((seat) => seat.phase === "review")).toHaveLength(1)
    expect(manifest.seats.some((seat) => seat.workgroupID === "ui-workgroup")).toBe(true)
    expect(manifest.seats.some((seat) => seat.workgroupID === "cli-workgroup")).toBe(true)
  })

  test("uses explicit seats when requested", () => {
    const manifest = allocateRepublicTeam({
      goal: "Implement protocol runtime",
      config: createConfig({
        team: {
          seat_allocation: "explicit",
          planner_seat_count: "auto",
          executor_seat_count: "auto",
          reviewer_seat_count: 2,
          seat_memory: true,
          persistent_sessions: true,
          max_parallel_seats: 4,
          default_runtime_agent: "general",
        },
        seats: {
          planners: ["protocol-seat"],
          executors: ["runtime-seat"],
          reviewers: ["compat-seat"],
          supervisors: ["chief-supervisor"],
        },
      }),
    })

    expect(manifest.seatAllocation).toBe("explicit")
    expect(manifest.seats.map((seat) => seat.seatID)).toEqual([
      "protocol-seat",
      "runtime-seat",
      "compat-seat",
      "chief-supervisor",
    ])
  })
})
