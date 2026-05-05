import type { RepublicConfig } from "../../config"
import type { RepublicTeamManifest, RepublicTeamPhase, RepublicTeamSeatDefinition } from "../../shared/git-worktree"

type RepublicDomain = {
  key: string
  label: string
  workgroupID: string
  module: string
  plannerRole: string
  executorRole: string
  reviewerRole?: string
  keywords: string[]
  fileHints: string[]
}

export interface RepublicSeatAllocationInput {
  goal: string
  config: RepublicConfig
  files?: string[]
  teamModel?: string
  seatAllocation?: "auto" | "count" | "explicit"
  plannerSeatCount?: number | "auto"
  executorSeatCount?: number | "auto"
  reviewerSeatCount?: number | "auto"
}

const DOMAINS: RepublicDomain[] = [
  {
    key: "api",
    label: "API",
    workgroupID: "api-workgroup",
    module: "src/api",
    plannerRole: "api-planner",
    executorRole: "api-executor",
    reviewerRole: "api-reviewer",
    keywords: ["api", "endpoint", "route", "http", "rest", "server", "接口", "路由", "服务"],
    fileHints: ["src/api", "routes", "server", "controller"],
  },
  {
    key: "data",
    label: "Data",
    workgroupID: "data-workgroup",
    module: "src/data",
    plannerRole: "data-planner",
    executorRole: "data-executor",
    reviewerRole: "data-reviewer",
    keywords: ["db", "database", "schema", "sql", "storage", "model", "数据", "数据库", "模型"],
    fileHints: ["src/db", "src/data", "schema", "migration", "models"],
  },
  {
    key: "ui",
    label: "UI",
    workgroupID: "ui-workgroup",
    module: "src/ui",
    plannerRole: "ui-planner",
    executorRole: "ui-executor",
    reviewerRole: "ux-reviewer",
    keywords: ["ui", "frontend", "dashboard", "component", "react", "view", "page", "界面", "面板", "可视化"],
    fileHints: ["src/ui", "src/components", "frontend", "dashboard", "app"],
  },
  {
    key: "cli",
    label: "CLI",
    workgroupID: "cli-workgroup",
    module: "src/cli",
    plannerRole: "cli-planner",
    executorRole: "cli-executor",
    reviewerRole: "cli-reviewer",
    keywords: ["cli", "command", "terminal", "shell", "命令", "终端"],
    fileHints: ["src/cli", "commands"],
  },
  {
    key: "config",
    label: "Config",
    workgroupID: "config-workgroup",
    module: "src/config",
    plannerRole: "config-planner",
    executorRole: "config-executor",
    reviewerRole: "config-reviewer",
    keywords: ["config", "schema", "settings", "json", "配置"],
    fileHints: ["src/config", "schema", "config"],
  },
  {
    key: "test",
    label: "Test",
    workgroupID: "test-workgroup",
    module: "tests",
    plannerRole: "test-planner",
    executorRole: "test-executor",
    reviewerRole: "test-reviewer",
    keywords: ["test", "spec", "qa", "coverage", "测试", "验证"],
    fileHints: ["test", "spec", "__tests__"],
  },
  {
    key: "docs",
    label: "Docs",
    workgroupID: "docs-workgroup",
    module: "docs",
    plannerRole: "docs-planner",
    executorRole: "docs-executor",
    reviewerRole: "docs-reviewer",
    keywords: ["docs", "readme", "guide", "documentation", "文档", "说明"],
    fileHints: ["docs", "readme"],
  },
  {
    key: "infra",
    label: "Infra",
    workgroupID: "infra-workgroup",
    module: ".github",
    plannerRole: "infra-planner",
    executorRole: "infra-executor",
    reviewerRole: "infra-reviewer",
    keywords: ["ci", "deploy", "docker", "workflow", "release", "部署", "流水线"],
    fileHints: [".github", "docker", "deploy", "workflow"],
  },
  {
    key: "security",
    label: "Security",
    workgroupID: "security-workgroup",
    module: "security",
    plannerRole: "security-planner",
    executorRole: "security-executor",
    reviewerRole: "security-reviewer",
    keywords: ["security", "auth", "permission", "secret", "token", "安全", "权限", "认证"],
    fileHints: ["auth", "security", "permission"],
  },
]

function normalizeCount(value: number | "auto" | undefined, fallback: number, max: number): number {
  if (typeof value === "number") {
    return Math.min(max, Math.max(1, value))
  }
  return Math.min(max, Math.max(1, fallback))
}

function scoreDomain(domain: RepublicDomain, text: string, files: string[]): number {
  let score = 0
  for (const keyword of domain.keywords) {
    if (text.includes(keyword.toLowerCase())) score += 2
  }
  for (const file of files) {
    const lowerFile = file.toLowerCase()
    if (domain.fileHints.some((hint) => lowerFile.includes(hint.toLowerCase()))) {
      score += 3
    }
  }
  return score
}

function inferDomains(goal: string, files: string[]): RepublicDomain[] {
  const text = `${goal}\n${files.join("\n")}`.toLowerCase()
  const scored = DOMAINS
    .map((domain) => ({ domain, score: scoreDomain(domain, text, files) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.domain)

  if (scored.length > 0) {
    return scored
  }

  return [DOMAINS[0]!, DOMAINS[5]!, DOMAINS[6]!]
}

function createSeat(domain: RepublicDomain, phase: RepublicTeamPhase, role: string, suffix: string, reason: string, runtimeAgent: string): RepublicTeamSeatDefinition {
  return {
    seatID: `${domain.key}-${suffix}-seat`,
    role,
    phase,
    workgroupID: domain.workgroupID,
    module: domain.module,
    runtimeAgent,
    reason,
  }
}

function uniqueSeats(seats: RepublicTeamSeatDefinition[]): RepublicTeamSeatDefinition[] {
  const seen = new Set<string>()
  const result: RepublicTeamSeatDefinition[] = []
  for (const seat of seats) {
    if (seen.has(seat.seatID)) continue
    seen.add(seat.seatID)
    result.push(seat)
  }
  return result
}

function explicitSeats(config: RepublicConfig, runtimeAgent: string): RepublicTeamSeatDefinition[] {
  const seats: RepublicTeamSeatDefinition[] = []
  for (const seatID of config.seats.planners) {
    seats.push({ seatID, role: "planner", phase: "planning", runtimeAgent, reason: "Explicit planner seat from user config." })
  }
  for (const seatID of config.seats.executors) {
    seats.push({ seatID, role: "executor", phase: "execution", runtimeAgent, reason: "Explicit executor seat from user config." })
  }
  for (const seatID of config.seats.reviewers) {
    seats.push({ seatID, role: "reviewer", phase: "review", runtimeAgent, reason: "Explicit reviewer seat from user config." })
  }
  for (const seatID of config.seats.supervisors) {
    seats.push({ seatID, role: "supervisor", phase: "idle", runtimeAgent, reason: "Explicit supervisor seat from user config." })
  }
  return uniqueSeats(seats)
}

export function allocateRepublicTeam(input: RepublicSeatAllocationInput): RepublicTeamManifest {
  const config = input.config
  const runtimeAgent = config.team.default_runtime_agent
  const seatAllocation = input.seatAllocation ?? config.team.seat_allocation
  const teamModel = input.teamModel ?? config.team_model

  if (seatAllocation === "explicit") {
    return {
      teamModel,
      seatAllocation,
      maxParallelSeats: config.team.max_parallel_seats,
      defaultRuntimeAgent: runtimeAgent,
      seats: explicitSeats(config, runtimeAgent),
    }
  }

  const domains = inferDomains(input.goal, input.files ?? [])
  const plannerCount = normalizeCount(input.plannerSeatCount ?? config.team.planner_seat_count, Math.min(4, Math.max(2, domains.length)), 20)
  const executorCount = normalizeCount(input.executorSeatCount ?? config.team.executor_seat_count, Math.min(4, Math.max(1, domains.filter((domain) => !["docs", "security"].includes(domain.key)).length)), 20)
  const reviewerCount = normalizeCount(input.reviewerSeatCount ?? config.team.reviewer_seat_count, 2, 20)
  const seats: RepublicTeamSeatDefinition[] = []

  for (let index = 0; index < plannerCount; index += 1) {
    const domain = domains[index % domains.length] ?? DOMAINS[0]!
    seats.push(createSeat(
      domain,
      "planning",
      domain.plannerRole,
      index < domains.length ? "planner" : `planner-${index + 1}`,
      `Allocated for planning because the task appears to involve ${domain.label}.`,
      runtimeAgent,
    ))
  }

  for (let index = 0; index < executorCount; index += 1) {
    const domain = domains[index % domains.length] ?? DOMAINS[0]!
    seats.push(createSeat(
      domain,
      "execution",
      domain.executorRole,
      index < domains.length ? "executor" : `executor-${index + 1}`,
      `Allocated for execution because the task appears to involve ${domain.label}.`,
      runtimeAgent,
    ))
  }

  const reviewDomains = domains.filter((domain) => domain.reviewerRole)
  for (let index = 0; index < reviewerCount; index += 1) {
    const domain = reviewDomains[index % reviewDomains.length] ?? DOMAINS[5]!
    seats.push(createSeat(
      domain,
      "review",
      domain.reviewerRole ?? "reviewer",
      index < reviewDomains.length ? "review" : `review-${index + 1}`,
      `Allocated for review coverage around ${domain.label}.`,
      runtimeAgent,
    ))
  }

  for (const supervisor of config.seats.supervisors.length > 0 ? config.seats.supervisors : ["republic-supervisor"]) {
    seats.push({
      seatID: supervisor,
      role: "supervisor",
      phase: "idle",
      runtimeAgent,
      conceptualAgent: config.scheduler.supervisor_agent,
      reason: "Supervisor seat coordinates blockers, objections, and phase transitions.",
    })
  }

  return {
    teamModel,
    seatAllocation,
    maxParallelSeats: config.team.max_parallel_seats,
    defaultRuntimeAgent: runtimeAgent,
    seats: uniqueSeats(seats),
  }
}
