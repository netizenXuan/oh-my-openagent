import type { OhMyOpenCodeConfig, RepublicConfig } from "../config"

export function isRepublicSeatOrchestrationExclusive(config?: Pick<OhMyOpenCodeConfig, "republic"> | { republic?: RepublicConfig }): boolean {
  const republic = config?.republic
  if (!republic?.enabled) return false
  if (republic.mode === "manual") return false
  if (republic.team_model === "single" || republic.team_model === "advisory") return false
  return republic.team.exclusive_seat_orchestration !== false
}

export function buildRepublicExclusiveSeatSystemPrompt(config?: Pick<OhMyOpenCodeConfig, "republic"> | { republic?: RepublicConfig }): string | null {
  const republic = config?.republic
  if (!isRepublicSeatOrchestrationExclusive(config) || !republic) {
    return null
  }

  return [
    "<republic-seat-orchestration>",
    "Republic seats are the active multi-agent orchestration system for this session.",
    `team_model=${republic.team_model}`,
    `seat_allocation=${republic.team.seat_allocation}`,
    `max_parallel_seats=${republic.team.max_parallel_seats}`,
    "",
    "Rules:",
    "1. Treat Republic seats as the planning, collaboration, and execution carriers.",
    "2. Do not create an independent OMO subagent decomposition with task/call_omo_agent while Republic seats are active.",
    "3. Use republic_team_init to create or update the team, republic_round_start to launch seat rounds, republic_publish/republic_wait for seat communication, republic_contract for shared interfaces, and republic_seat_update for seat status.",
    "4. Existing OMO runtime agents may still execute a seat, but they are transport for that seat rather than a second orchestration layer.",
    "5. If you need more workers, allocate or launch more Republic seats instead of asking Sisyphus/Atlas/Hephaestus to independently delegate subagents.",
    "</republic-seat-orchestration>",
  ].join("\n")
}

export function getRepublicExclusiveSeatDelegationError(config?: Pick<OhMyOpenCodeConfig, "republic"> | { republic?: RepublicConfig }): string | null {
  if (!isRepublicSeatOrchestrationExclusive(config)) {
    return null
  }

  return [
    "Republic seat orchestration is active and exclusive for this session.",
    "Do not use the legacy OMO task/call_omo_agent delegation path as a parallel orchestration layer.",
    "Use republic_team_init, republic_round_start, republic_publish, republic_wait, republic_contract, and republic_seat_update so all planning, execution, communication, and supervision stay attached to durable Republic seats.",
  ].join(" ")
}
