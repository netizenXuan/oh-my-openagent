import { describe, expect, test } from "bun:test"

import { RepublicConfigSchema } from "../config/schema"
import { createSystemTransformHandler } from "./system-transform"

describe("createSystemTransformHandler", () => {
  test("injects Republic exclusive seat orchestration guidance for active team modes", async () => {
    const handler = createSystemTransformHandler({
      pluginConfig: {
        republic: RepublicConfigSchema.parse({
          team_model: "parliament_squad",
        }),
      },
    })
    const output = { system: [] as string[] }

    await handler({ sessionID: "ses_1", model: { id: "k2.6", providerID: "kimi" } }, output)

    expect(output.system).toHaveLength(1)
    expect(output.system[0]).toContain("<republic-seat-orchestration>")
    expect(output.system[0]).toContain("Republic seats are the active multi-agent orchestration system")
    expect(output.system[0]).toContain("Do not create an independent OMO subagent decomposition")
    expect(output.system[0]).toContain("team_model=parliament_squad")
  })

  test("does not inject guidance for advisory mode", async () => {
    const handler = createSystemTransformHandler({
      pluginConfig: {
        republic: RepublicConfigSchema.parse({
          team_model: "advisory",
        }),
      },
    })
    const output = { system: [] as string[] }

    await handler({ sessionID: "ses_1", model: { id: "k2.6", providerID: "kimi" } }, output)

    expect(output.system).toEqual([])
  })
})
