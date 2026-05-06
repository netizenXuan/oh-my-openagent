import { z } from "zod"

export const RepublicModeSchema = z.enum(["manual", "advisory", "governed"])
export const RepublicDependencyGateModeSchema = z.enum(["advisory", "block"])
export const RepublicGuardrailGateModeSchema = z.enum(["advisory", "block"])
export const RepublicSchedulerMessageTypeSchema = z.enum(["question", "handoff", "objection"])
export const RepublicTeamModelSchema = z.enum(["single", "advisory", "parliament", "squad", "parliament_squad"])
export const RepublicSeatAllocationSchema = z.enum(["auto", "count", "explicit"])
export const RepublicSeatCountSchema = z.union([
  z.literal("auto"),
  z.number().int().min(1).max(20),
])

const DEFAULT_HIGH_RISK_PATHS = [
  "package.json",
  "bun.lock",
  "src/config/",
  "src/plugin/",
  "src/shared/git-worktree/",
  ".github/workflows/",
]

export const RepublicConfigSchema = z.object({
  /** Enable OMO Republic deliberative workflow helpers. */
  enabled: z.boolean().default(true),
  /** advisory records and recommends; governed may enforce gates in future versions. */
  mode: RepublicModeSchema.default("advisory"),
  /** Write deliberation ledger and artifacts under the Git common dir. */
  ledger: z.boolean().default(true),
  /** Fast same-role planner seats, inspired by House-style broad representation. */
  house_seats: z.number().int().min(1).max(9).default(3),
  /** Conservative same-role planner seats, inspired by Senate-style stability review. */
  senate_seats: z.number().int().min(1).max(7).default(2),
  /** Reviewer seats that can flag blockers before execution. */
  review_bench_seats: z.number().int().min(1).max(7).default(2),
  /** Minimum seat records expected before a conference report is considered complete. */
  quorum: z.number().int().min(1).max(20).default(4),
  /** Fraction of approve votes required for high-confidence execution recommendation. */
  supermajority: z.number().min(0.5).max(1).default(0.67),
  /** Treat any blocker/reject vote from review bench as a veto in final recommendation. */
  veto_on_blocker: z.boolean().default(true),
  /** Include native-git audit summary when building republic status reports. */
  git_summary: z.boolean().default(true),
  /** Optional persistent-team orchestration model. */
  team_model: RepublicTeamModelSchema.default("advisory"),
  /** Persistent team and dynamic seat allocation controls. */
  team: z.object({
    seat_allocation: RepublicSeatAllocationSchema.default("auto"),
    seat_memory: z.boolean().default(true),
    persistent_sessions: z.boolean().default(true),
    planner_seat_count: RepublicSeatCountSchema.default("auto"),
    executor_seat_count: RepublicSeatCountSchema.default("auto"),
    reviewer_seat_count: RepublicSeatCountSchema.default(2),
    max_parallel_seats: z.number().int().min(1).max(20).default(4),
    default_runtime_agent: z.string().min(1).default("general"),
  }).default({
    seat_allocation: "auto",
    seat_memory: true,
    persistent_sessions: true,
    planner_seat_count: "auto",
    executor_seat_count: "auto",
    reviewer_seat_count: 2,
    max_parallel_seats: 4,
    default_runtime_agent: "general",
  }),
  /** Optional explicit seat lists for advanced users. */
  seats: z.object({
    planners: z.array(z.string().min(1)).default([]),
    executors: z.array(z.string().min(1)).default([]),
    reviewers: z.array(z.string().min(1)).default([]),
    supervisors: z.array(z.string().min(1)).default(["republic-supervisor"]),
  }).default({
    planners: [],
    executors: [],
    reviewers: [],
    supervisors: ["republic-supervisor"],
  }),
  /** Publish native-git tool changes into the Republic Commons automatically. */
  commons: z.object({
    auto_publish: z.boolean().default(true),
    inbox: z.boolean().default(true),
    inject_max_messages: z.number().int().min(1).max(20).default(6),
    agent_docs: z.boolean().default(true),
  }).default({
    auto_publish: true,
    inbox: true,
    inject_max_messages: 6,
    agent_docs: true,
  }),
  /** Record supervisor interventions when changes look high-risk or role boundaries are crossed. */
  supervisor: z.object({
    intervention: z.boolean().default(true),
    policy_loop: z.boolean().default(true),
    file_threshold: z.number().int().min(1).max(50).default(5),
    high_risk_paths: z.array(z.string().min(1)).default(DEFAULT_HIGH_RISK_PATHS),
  }).default({
    intervention: true,
    policy_loop: true,
    file_threshold: 5,
    high_risk_paths: DEFAULT_HIGH_RISK_PATHS,
  }),
  /** Warn or block when one tool call crosses multiple inferred workgroups. */
  dependency_gate: z.object({
    enabled: z.boolean().default(true),
    mode: RepublicDependencyGateModeSchema.default("advisory"),
    cross_module_threshold: z.number().int().min(2).max(20).default(2),
  }).default({
    enabled: true,
    mode: "advisory",
    cross_module_threshold: 2,
  }),
  /** Store workgroup contracts for cross-module interface agreements. */
  contracts: z.object({
    enabled: z.boolean().default(true),
  }).default({
    enabled: true,
  }),
  /** Guardrails that make Republic safer for cheaper or weaker models. */
  weak_model_guardrails: z.object({
    enabled: z.boolean().default(true),
    labeled_context: z.boolean().default(true),
    require_context_before_edit: z.boolean().default(true),
    require_explicit_context_read: z.boolean().default(false),
    pre_edit_context_gate: RepublicGuardrailGateModeSchema.default("advisory"),
  }).default({
    enabled: true,
    labeled_context: true,
    require_context_before_edit: true,
    require_explicit_context_read: false,
    pre_edit_context_gate: "advisory",
  }),
  /** Actively dispatch targeted Commons messages to background seat sessions. */
  scheduler: z.object({
    enabled: z.boolean().default(true),
    auto_dispatch: z.boolean().default(true),
    message_types: z.array(RepublicSchedulerMessageTypeSchema).default(["question", "handoff", "objection"]),
    default_agent: z.string().min(1).default("sisyphus"),
    supervisor_agent: z.string().min(1).default("hephaestus"),
    seat_agents: z.record(z.string().min(1), z.string().min(1)).default({}),
    prompt_max_messages: z.number().int().min(1).max(20).default(8),
  }).default({
    enabled: true,
    auto_dispatch: true,
    message_types: ["question", "handoff", "objection"],
    default_agent: "sisyphus",
    supervisor_agent: "hephaestus",
    seat_agents: {},
    prompt_max_messages: 8,
  }),
})

export type RepublicMode = z.infer<typeof RepublicModeSchema>
export type RepublicDependencyGateMode = z.infer<typeof RepublicDependencyGateModeSchema>
export type RepublicGuardrailGateMode = z.infer<typeof RepublicGuardrailGateModeSchema>
export type RepublicSchedulerMessageType = z.infer<typeof RepublicSchedulerMessageTypeSchema>
export type RepublicTeamModel = z.infer<typeof RepublicTeamModelSchema>
export type RepublicSeatAllocation = z.infer<typeof RepublicSeatAllocationSchema>
export type RepublicSeatCount = z.infer<typeof RepublicSeatCountSchema>
export type RepublicConfig = z.infer<typeof RepublicConfigSchema>
