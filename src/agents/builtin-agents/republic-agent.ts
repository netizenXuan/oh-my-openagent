import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentOverrides } from "../types"
import type { CategoryConfig } from "../../config/schema"
import { AGENT_MODEL_REQUIREMENTS } from "../../shared"
import { applyOverrides } from "./agent-overrides"
import { applyModelResolution, getFirstFallbackModel } from "./model-resolution"
import { createRepublicAgent } from "../republic"

export function maybeCreateRepublicConfig(input: {
  disabledAgents: string[]
  agentOverrides: AgentOverrides
  uiSelectedModel?: string
  availableModels: Set<string>
  systemDefaultModel?: string
  isFirstRunNoCache: boolean
  mergedCategories: Record<string, CategoryConfig>
  directory?: string
}): AgentConfig | undefined {
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

  if (disabledAgents.includes("republic")) return undefined

  const republicOverride = agentOverrides.republic
  const republicRequirement = AGENT_MODEL_REQUIREMENTS.republic
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

  if (!republicResolution) return undefined
  const { model, variant } = republicResolution

  let republicConfig = createRepublicAgent(model)
  if (variant) {
    republicConfig = { ...republicConfig, variant }
  }

  return applyOverrides(republicConfig, republicOverride, mergedCategories, directory)
}
