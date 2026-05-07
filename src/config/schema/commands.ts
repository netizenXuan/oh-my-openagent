import { z } from "zod"

export const BuiltinCommandNameSchema = z.enum([
  "init-deep",
  "ralph-loop",
  "ulw-loop",
  "cancel-ralph",
  "refactor",
  "deliberate",
  "republic-status",
  "republic-dashboard",
  "start-work",
  "stop-continuation",
  "handoff",
  "remove-ai-slops",
])

export type BuiltinCommandName = z.infer<typeof BuiltinCommandNameSchema>
