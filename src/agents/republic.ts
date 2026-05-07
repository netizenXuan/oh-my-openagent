import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode } from "./types"

const MODE: AgentMode = "primary"

export type RepublicAgentPreset = "standard" | "large" | "extreme"

export type RepublicAgentPresetConfig = {
  preset: RepublicAgentPreset
  label: string
  description: string
  color: string
  maxParallelSeats: number
  plannerSeatCount?: number
  executorSeatCount?: number
  reviewerSeatCount?: number
}

export const REPUBLIC_AGENT_PRESETS: Record<RepublicAgentPreset, RepublicAgentPresetConfig> = {
  standard: {
    preset: "standard",
    label: "Standard",
    description: "Balanced default Republic team for normal multi-seat work.",
    color: "#7C3AED",
    maxParallelSeats: 4,
  },
  large: {
    preset: "large",
    label: "Large",
    description: "Larger Republic team for broad projects that need more parallel planning, execution, and review.",
    color: "#2563EB",
    maxParallelSeats: 8,
    plannerSeatCount: 4,
    executorSeatCount: 4,
    reviewerSeatCount: 3,
  },
  extreme: {
    preset: "extreme",
    label: "Extreme",
    description: "Maximum Republic team for large, high-risk, or stress-test projects.",
    color: "#DC2626",
    maxParallelSeats: 12,
    plannerSeatCount: 6,
    executorSeatCount: 6,
    reviewerSeatCount: 4,
  },
}

function buildPresetInitializationInstruction(preset: RepublicAgentPresetConfig): string {
  const args = [
    'team_model="parliament_squad"',
    'seat_allocation="auto"',
    `max_parallel_seats=${preset.maxParallelSeats}`,
    preset.plannerSeatCount !== undefined ? `planner_seat_count=${preset.plannerSeatCount}` : undefined,
    preset.executorSeatCount !== undefined ? `executor_seat_count=${preset.executorSeatCount}` : undefined,
    preset.reviewerSeatCount !== undefined ? `reviewer_seat_count=${preset.reviewerSeatCount}` : undefined,
  ].filter((arg): arg is string => typeof arg === "string")

  return `Preset: ${preset.label}. When no user count overrides are provided, initialize with republic_team_init ${args.join(", ")}.`
}

export function createRepublicAgent(model: string, presetName: RepublicAgentPreset = "standard"): AgentConfig {
  const preset = REPUBLIC_AGENT_PRESETS[presetName]

  return {
    description:
      `Primary entry for OMO Republic ${preset.label}. ${preset.description} Runs persistent-seat planning, execution, Commons communication, supervisor governance, dashboard reporting, and native-git traceability. (Republic - OhMyOpenCode)`,
    mode: MODE,
    model,
    temperature: 0.1,
    color: preset.color,
    permission: {
      task: "deny",
      call_omo_agent: "deny",
    } as AgentConfig["permission"],
    prompt: `You are Republic - Team Orchestrator (${preset.label} preset).

You are the primary OpenCode App entry point for the existing OMO Republic governance system. Republic seats are not advisory notes. They are the planning, collaboration, execution, review, and supervisor carriers for complex work.

${buildPresetInitializationInstruction(preset)}

Core operating rules:

1. If the user asks for Republic, repwork, governance, team mode, multi-seat execution, or persistent seats, use OMO Republic tools as the source of truth.
2. Start by reading repository context and existing Republic state with republic_team_status. If no suitable team exists, initialize one with republic_team_init using this preset's default counts and max_parallel_seats unless the user specifies another model or count.
3. Use dynamic seat allocation. Infer the required planner, executor, reviewer, and supervisor seats from the task shape. Do not pre-lock roles before understanding the repo and task.
4. Treat seats as exclusive orchestration when team_model is parliament, squad, or parliament_squad. Do not create a parallel legacy OMO subagent plan with task or call_omo_agent. Existing runtime agents may execute a seat, but the durable seat identity, Commons, contracts, scheduler, and native-git ledger remain authoritative.
5. Planning phase: run independent seats, publish proposals and objections through Commons, form contracts, and have the supervisor resolve conflicts before execution.
6. Execution phase: launch seat rounds with republic_round_start, require workgroup contracts for dependent modules, publish question/answer/objection/revision/handoff messages, and use supervisor policy to intervene when seats drift or block each other.
7. For weak or cheap models, prefer explicit hard fields over prose. Keep messages structured with authorSeatID, targetSeatID, messageType, taskID, workgroupID, status, references, and concrete file lists.
8. Use native-git tracking and Republic ledger records for auditability. Do not commit unless the user explicitly asks.
9. If dashboard.auto_open is configured, let the Republic tools open the dashboard. Otherwise mention that /republic-dashboard --open can render the command board.

On activation, say "REPUBLIC WORK MODE ENABLED" and then proceed with bounded repository inspection and Republic state setup.`,
  }
}

createRepublicAgent.mode = MODE
