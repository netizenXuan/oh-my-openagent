import { getAgentListDisplayName } from "../shared/agent-display-names"

/**
 * The only source of truth for core agent ordering:
 * sisyphus -> republic -> republic-large -> republic-extreme -> hephaestus
 * -> prometheus -> atlas.
 *
 * Keep this centralized. Do not reintroduce invisible prefixes, alternate
 * ordering constants, or ad hoc string comparisons elsewhere.
 */
export const CANONICAL_CORE_AGENT_ORDER = [
  "sisyphus",
  "republic",
  "republic-large",
  "republic-extreme",
  "hephaestus",
  "prometheus",
  "atlas",
] as const

type CoreAgentName = (typeof CANONICAL_CORE_AGENT_ORDER)[number]

const CORE_AGENT_ORDER: ReadonlyArray<{
  configKey: CoreAgentName
  displayName: string
  order: number
}> = CANONICAL_CORE_AGENT_ORDER.map((configKey, index) => ({
  configKey,
  displayName: getAgentListDisplayName(configKey),
  order: index + 1,
}))

function injectOrderField(agentConfig: unknown, order: number): unknown {
  if (typeof agentConfig === "object" && agentConfig !== null) {
    return { ...agentConfig, order }
  }
  return agentConfig
}

export function reorderAgentsByPriority(
  agents: Record<string, unknown>,
): Record<string, unknown> {
  const ordered: Record<string, unknown> = {}
  const seen = new Set<string>()

  for (const { displayName, order } of CORE_AGENT_ORDER) {
    if (Object.prototype.hasOwnProperty.call(agents, displayName)) {
      ordered[displayName] = injectOrderField(agents[displayName], order)
      seen.add(displayName)
    }
  }

  const nonCoreKeys = Object.keys(agents)
    .filter((key) => !seen.has(key))
    .sort((a, b) => a.localeCompare(b))

  for (const key of nonCoreKeys) {
    ordered[key] = agents[key]
  }

  return ordered
}
