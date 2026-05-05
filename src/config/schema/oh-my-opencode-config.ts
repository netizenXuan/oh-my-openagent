import { z } from "zod"
import { AnyMcpNameSchema } from "../../mcp/types"
import { BuiltinSkillNameSchema } from "./agent-names"
import { AgentDefinitionsConfigSchema } from "./agent-definitions"
import { AgentOverridesSchema } from "./agent-overrides"
import { BabysittingConfigSchema } from "./babysitting"
import { BackgroundTaskConfigSchema } from "./background-task"
import { BrowserAutomationConfigSchema } from "./browser-automation"
import { CategoriesConfigSchema } from "./categories"
import { ClaudeCodeConfigSchema } from "./claude-code"
import { CommentCheckerConfigSchema } from "./comment-checker"
import { BuiltinCommandNameSchema } from "./commands"
import { ExperimentalConfigSchema } from "./experimental"
import { GitMasterConfigSchema } from "./git-master"
import { NativeGitConfigSchema } from "./git"
import { NotificationConfigSchema } from "./notification"
import { OpenClawConfigSchema } from "./openclaw"
import { ModelCapabilitiesConfigSchema } from "./model-capabilities"
import { RalphLoopConfigSchema } from "./ralph-loop"
import { RepublicConfigSchema } from "./republic"
import { RuntimeFallbackConfigSchema } from "./runtime-fallback"
import { SkillsConfigSchema } from "./skills"
import { SisyphusConfigSchema } from "./sisyphus"
import { SisyphusAgentConfigSchema } from "./sisyphus-agent"
import { TmuxConfigSchema } from "./tmux"
import { StartWorkConfigSchema } from "./start-work"
import { WebsearchConfigSchema } from "./websearch"

export const OhMyOpenCodeConfigSchema = z.object({
  $schema: z.string().optional(),
  /** Enable new task system (default: false) */
  new_task_system_enabled: z.boolean().optional(),
  /** Default agent name for `oh-my-opencode run` (env: OPENCODE_DEFAULT_AGENT) */
  default_run_agent: z.string().optional(),
  /** Paths to external agent definition files (.md or .json) */
  agent_definitions: AgentDefinitionsConfigSchema,
  disabled_mcps: z.array(AnyMcpNameSchema).optional(),
  disabled_agents: z.array(z.string()).optional(),
  disabled_skills: z.array(BuiltinSkillNameSchema).optional(),
  disabled_hooks: z.array(z.string()).optional(),
  disabled_commands: z.array(BuiltinCommandNameSchema).optional(),
  /** Disable specific tools by name (e.g., ["todowrite", "todoread"]) */
  disabled_tools: z.array(z.string()).optional(),
  mcp_env_allowlist: z.array(z.string()).optional(),
  /** Enable hashline_edit tool/hook integrations (default: false) */
  hashline_edit: z.boolean().optional(),
  /** Enable model fallback on API errors (default: false). Set to true to enable automatic model switching when model errors occur. */
  model_fallback: z.boolean().optional(),
  agents: AgentOverridesSchema.optional(),
  categories: CategoriesConfigSchema.optional(),
  claude_code: ClaudeCodeConfigSchema.optional(),
  sisyphus_agent: SisyphusAgentConfigSchema.optional(),
  comment_checker: CommentCheckerConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  auto_update: z.boolean().optional(),
  skills: SkillsConfigSchema.optional(),
  ralph_loop: RalphLoopConfigSchema.optional(),
  /**
   * Enable runtime fallback (default: false)
   * Set to false to disable, or use object for advanced config:
   * { "enabled": true, "retry_on_errors": [400, 429], "timeout_seconds": 30 }
   */
  runtime_fallback: z.union([z.boolean(), RuntimeFallbackConfigSchema]).optional(),
  background_task: BackgroundTaskConfigSchema.optional(),
  notification: NotificationConfigSchema.optional(),
  model_capabilities: ModelCapabilitiesConfigSchema.optional(),
  openclaw: OpenClawConfigSchema.optional(),
  babysitting: BabysittingConfigSchema.optional(),
  git_master: GitMasterConfigSchema.default({
    commit_footer: true,
    include_co_authored_by: true,
    git_env_prefix: "GIT_MASTER=1",
  }),
  git: NativeGitConfigSchema.default({
    mode: "tracked",
    audit_log: true,
  }),
  republic: RepublicConfigSchema.default({
    enabled: true,
    mode: "advisory",
    ledger: true,
    house_seats: 3,
    senate_seats: 2,
    review_bench_seats: 2,
    quorum: 4,
    supermajority: 0.67,
    veto_on_blocker: true,
    git_summary: true,
    team_model: "advisory",
    team: {
      seat_allocation: "auto",
      seat_memory: true,
      persistent_sessions: true,
      planner_seat_count: "auto",
      executor_seat_count: "auto",
      reviewer_seat_count: 2,
      max_parallel_seats: 4,
      default_runtime_agent: "general",
    },
    seats: {
      planners: [],
      executors: [],
      reviewers: [],
      supervisors: ["republic-supervisor"],
    },
    commons: {
      auto_publish: true,
      inbox: true,
      inject_max_messages: 6,
      agent_docs: true,
    },
    supervisor: {
      intervention: true,
      policy_loop: true,
      file_threshold: 5,
      high_risk_paths: [
        "package.json",
        "bun.lock",
        "src/config/",
        "src/plugin/",
        "src/shared/git-worktree/",
        ".github/workflows/",
      ],
    },
    dependency_gate: {
      enabled: true,
      mode: "advisory",
      cross_module_threshold: 2,
    },
    contracts: {
      enabled: true,
    },
    scheduler: {
      enabled: true,
      auto_dispatch: true,
      message_types: ["question", "handoff", "objection"],
      default_agent: "sisyphus",
      supervisor_agent: "hephaestus",
      seat_agents: {},
      prompt_max_messages: 8,
    },
  }),
  browser_automation_engine: BrowserAutomationConfigSchema.optional(),
  websearch: WebsearchConfigSchema.optional(),
  tmux: TmuxConfigSchema.optional(),
  sisyphus: SisyphusConfigSchema.optional(),
  start_work: StartWorkConfigSchema.optional(),
  /** Migration history to prevent re-applying migrations (e.g., model version upgrades) */
  _migrations: z.array(z.string()).optional(),
})

export type OhMyOpenCodeConfig = z.infer<typeof OhMyOpenCodeConfigSchema>
