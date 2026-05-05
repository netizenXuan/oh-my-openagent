import { z } from "zod"

export const RepublicModeSchema = z.enum(["manual", "advisory", "governed"])
export const RepublicDependencyGateModeSchema = z.enum(["advisory", "block"])

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
  /** Publish native-git tool changes into the Republic Commons automatically. */
  commons: z.object({
    auto_publish: z.boolean().default(true),
  }).default({
    auto_publish: true,
  }),
  /** Record supervisor interventions when changes look high-risk or role boundaries are crossed. */
  supervisor: z.object({
    intervention: z.boolean().default(true),
    file_threshold: z.number().int().min(1).max(50).default(5),
    high_risk_paths: z.array(z.string().min(1)).default(DEFAULT_HIGH_RISK_PATHS),
  }).default({
    intervention: true,
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
})

export type RepublicMode = z.infer<typeof RepublicModeSchema>
export type RepublicDependencyGateMode = z.infer<typeof RepublicDependencyGateModeSchema>
export type RepublicConfig = z.infer<typeof RepublicConfigSchema>
