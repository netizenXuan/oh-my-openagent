import { describe, expect, test } from "bun:test"

import { RepublicConfigSchema } from "../config/schema"
import {
  buildRepublicExclusiveSeatSystemPrompt,
  getRepublicExclusiveSeatDelegationError,
  isRepublicSeatOrchestrationExclusive,
} from "./exclusive-seat-orchestration"

describe("exclusive Republic seat orchestration", () => {
  test("activates only for real team modes", () => {
    expect(isRepublicSeatOrchestrationExclusive({
      republic: RepublicConfigSchema.parse({ team_model: "advisory" }),
    })).toBe(false)
    expect(isRepublicSeatOrchestrationExclusive({
      republic: RepublicConfigSchema.parse({ team_model: "parliament" }),
    })).toBe(true)
    expect(isRepublicSeatOrchestrationExclusive({
      republic: RepublicConfigSchema.parse({ team_model: "squad" }),
    })).toBe(true)
    expect(isRepublicSeatOrchestrationExclusive({
      republic: RepublicConfigSchema.parse({ team_model: "parliament_squad" }),
    })).toBe(true)
  })

  test("respects manual mode and explicit opt-out", () => {
    expect(isRepublicSeatOrchestrationExclusive({
      republic: RepublicConfigSchema.parse({
        mode: "manual",
        team_model: "parliament_squad",
      }),
    })).toBe(false)
    expect(isRepublicSeatOrchestrationExclusive({
      republic: RepublicConfigSchema.parse({
        team_model: "parliament_squad",
        team: {
          exclusive_seat_orchestration: false,
        },
      }),
    })).toBe(false)
  })

  test("builds prompt and tool error text for exclusive mode", () => {
    const config = {
      republic: RepublicConfigSchema.parse({
        team_model: "parliament_squad",
        team: {
          seat_allocation: "count",
          planner_seat_count: 5,
        },
      }),
    }

    expect(buildRepublicExclusiveSeatSystemPrompt(config)).toContain("team_model=parliament_squad")
    expect(buildRepublicExclusiveSeatSystemPrompt(config)).toContain("allocate or launch more Republic seats")
    expect(getRepublicExclusiveSeatDelegationError(config)).toContain("legacy OMO task/call_omo_agent delegation path")
  })
})
