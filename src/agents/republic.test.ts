import { describe, expect, test } from "bun:test"

import { createRepublicAgent } from "./republic"

describe("createRepublicAgent", () => {
  test("creates a primary OpenCode App entry for Republic governance", () => {
    const agent = createRepublicAgent("opencode/kimi-k2.5")

    expect(agent.mode).toBe("primary")
    expect(agent.model).toBe("opencode/kimi-k2.5")
    expect(agent.description).toContain("OMO Republic")
    expect(agent.prompt).toContain("REPUBLIC WORK MODE ENABLED")
    expect(agent.prompt).toContain("republic_team_init")
    expect(agent.prompt).toContain("seat_allocation=\"auto\"")
    expect(agent.prompt).toContain("max_parallel_seats=4")
  })

  test("creates larger Republic presets for direct App selection", () => {
    const large = createRepublicAgent("opencode/kimi-k2.5", "large")
    const extreme = createRepublicAgent("opencode/kimi-k2.5", "extreme")

    expect(large.description).toContain("Large")
    expect(large.prompt).toContain("max_parallel_seats=8")
    expect(large.prompt).toContain("planner_seat_count=4")
    expect(large.prompt).toContain("executor_seat_count=4")
    expect(large.prompt).toContain("reviewer_seat_count=3")
    expect(extreme.description).toContain("Extreme")
    expect(extreme.prompt).toContain("max_parallel_seats=12")
    expect(extreme.prompt).toContain("planner_seat_count=6")
    expect(extreme.prompt).toContain("executor_seat_count=6")
    expect(extreme.prompt).toContain("reviewer_seat_count=4")
  })

  test("keeps Republic seats exclusive from legacy OMO fan-out tools", () => {
    const agent = createRepublicAgent("opencode/kimi-k2.5")

    expect(agent.permission).toMatchObject({
      task: "deny",
      call_omo_agent: "deny",
    })
  })
})
