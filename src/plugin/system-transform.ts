import type { OhMyOpenCodeConfig } from "../config"

import { buildRepublicExclusiveSeatSystemPrompt } from "../republic/exclusive-seat-orchestration"

export function createSystemTransformHandler(args: { pluginConfig?: Pick<OhMyOpenCodeConfig, "republic"> } = {}): (
  input: { sessionID?: string; model: { id: string; providerID: string; [key: string]: unknown } },
  output: { system: string[] },
) => Promise<void> {
  return async (_input, output): Promise<void> => {
    const republicPrompt = buildRepublicExclusiveSeatSystemPrompt(args.pluginConfig)
    if (republicPrompt) {
      output.system.push(republicPrompt)
    }
  }
}
