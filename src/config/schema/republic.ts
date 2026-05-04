import { z } from "zod"

export const RepublicModeSchema = z.enum(["manual", "advisory", "governed"])

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
})

export type RepublicMode = z.infer<typeof RepublicModeSchema>
export type RepublicConfig = z.infer<typeof RepublicConfigSchema>
