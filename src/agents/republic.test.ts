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
  })

  test("keeps Republic seats exclusive from legacy OMO fan-out tools", () => {
    const agent = createRepublicAgent("opencode/kimi-k2.5")

    expect(agent.permission).toMatchObject({
      task: "deny",
      call_omo_agent: "deny",
    })
  })
})
