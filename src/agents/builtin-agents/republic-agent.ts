import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentOverrides } from "../types"
import type { CategoryConfig } from "../../config/schema"
import { AGENT_MODEL_REQUIREMENTS } from "../../shared"
import { applyOverrides } from "./agent-overrides"
import { applyModelResolution, getFirstFallbackModel } from "./model-resolution"
import { createRepublicAgent, type RepublicAgentPreset } from "../republic"

type RepublicAgentKey = "republic" | "republic-large" | "republic-extreme"

const REPUBLIC_AGENT_KEYS: Array<{ key: RepublicAgentKey; preset: RepublicAgentPreset }> = [
  { key: "republic", preset: "standard" },
  { key: "republic-large", preset: "large" },
  { key: "republic-extreme", preset: "extreme" },
]

export function maybeCreateRepublicConfigs(input: {
  disabledAgents: string[]
  agentOverrides: AgentOverrides
  uiSelectedModel?: string
  availableModels: Set<string>
  systemDefaultModel?: string
  isFirstRunNoCache: boolean
  mergedCategories: Record<string, CategoryConfig>
  directory?: string
}): Partial<Record<RepublicAgentKey, AgentConfig>> {
  const {
    disabledAgents,
    agentOverrides,
    uiSelectedModel,
    availableModels,
    systemDefaultModel,
    isFirstRunNoCache,
    mergedCategories,
    directory,
  } = input

  const result: Partial<Record<RepublicAgentKey, AgentConfig>> = {}
  const disabled = new Set(disabledAgents.map((agent) => agent.toLowerCase()))
  const baseDisabled = disabled.has("republic")

  for (const { key, preset } of REPUBLIC_AGENT_KEYS) {
    if (baseDisabled || disabled.has(key)) continue

    const republicOverride = agentOverrides[key]
    const republicRequirement = AGENT_MODEL_REQUIREMENTS[key] ?? AGENT_MODEL_REQUIREMENTS.republic
    let republicResolution = applyModelResolution({
      uiSelectedModel: republicOverride?.model !== undefined ? undefined : uiSelectedModel,
      userModel: republicOverride?.model,
      requirement: republicRequirement,
      availableModels,
      systemDefaultModel,
    })

    if (isFirstRunNoCache && !republicOverride?.model && !uiSelectedModel) {
      republicResolution = getFirstFallbackModel(republicRequirement)
    }

    if (!republicResolution) continue
    const { model, variant } = republicResolution

    let republicConfig = createRepublicAgent(model, preset)
    if (variant) {
      republicConfig = { ...republicConfig, variant }
    }

    result[key] = applyOverrides(republicConfig, republicOverride, mergedCategories, directory)
  }

  return result
}

export function maybeCreateRepublicConfig(input: Parameters<typeof maybeCreateRepublicConfigs>[0]): AgentConfig | undefined {
  return maybeCreateRepublicConfigs(input).republic
}
