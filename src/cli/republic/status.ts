import {
  getNativeGitRepository,
  evaluateRepublicDecision,
  summarizeNativeGitAudit,
  summarizeRepublicCommons,
  summarizeRepublicLedger,
  type RepublicDecision,
  type NativeGitAuditSummary,
  type NativeGitRepository,
  type RepublicCommonsSummary,
  type RepublicLedgerSummary,
} from "../../shared/git-worktree"

export interface RepublicStatusOptions {
  directory?: string
  deliberationId?: string
  json?: boolean
}

export interface RepublicStatusReport {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID?: string
  republic: RepublicLedgerSummary
  commons: RepublicCommonsSummary
  decision: RepublicDecision
  nativeGit: NativeGitAuditSummary
}

function formatCounter(counter: Record<string, number>): string {
  const entries = Object.entries(counter).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) {
    return "none"
  }

  return entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

function formatList(values: string[], limit = 12): string {
  if (values.length === 0) {
    return "none"
  }

  const shown = values.slice(0, limit).join(", ")
  return values.length > limit ? `${shown}, ... (+${values.length - limit} more)` : shown
}

function emptyRepublicSummary(deliberationID?: string): RepublicLedgerSummary {
  return {
    deliberationID,
    recordCount: 0,
    deliberationIDs: [],
    phases: {},
    chambers: {},
    agents: {},
    seats: [],
    votes: {
      approve: 0,
      revise: 0,
      reject: 0,
      abstain: 0,
      other: 0,
    },
    averageConfidence: null,
    files: [],
    blocked: false,
  }
}

function emptyCommonsSummary(deliberationID?: string): RepublicCommonsSummary {
  return {
    deliberationID,
    messageCount: 0,
    channels: {},
    phases: {},
    authors: {},
    agents: {},
    messageTypes: {},
    targetedMessages: 0,
    referencedMessages: 0,
    files: [],
  }
}

function emptyNativeGitSummary(): NativeGitAuditSummary {
  return {
    recordCount: 0,
    tools: {},
    agents: {},
    models: {},
    categories: {},
    sessions: {},
    files: [],
  }
}

export function buildRepublicStatusReport(options: RepublicStatusOptions = {}): RepublicStatusReport {
  const directory = options.directory ?? process.cwd()
  const repository = getNativeGitRepository(directory)
  const deliberationID = options.deliberationId
  const republic = repository ? summarizeRepublicLedger(repository, deliberationID) : emptyRepublicSummary(deliberationID)
  const commons = repository ? summarizeRepublicCommons(repository, deliberationID) : emptyCommonsSummary(deliberationID)

  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    republic,
    commons,
    decision: evaluateRepublicDecision(republic),
    nativeGit: repository ? summarizeNativeGitAudit(repository) : emptyNativeGitSummary(),
  }
}

export function formatRepublicStatusReport(report: RepublicStatusReport): string {
  if (!report.repository) {
    return "OMO Republic Status\n\nNot inside a git repository. No ledger or native-git audit can be read."
  }

  const republic = report.republic
  const commons = report.commons
  const decision = report.decision
  const nativeGit = report.nativeGit
  const voteLine = `approve=${republic.votes.approve}, revise=${republic.votes.revise}, reject=${republic.votes.reject}, abstain=${republic.votes.abstain}, other=${republic.votes.other}`
  const nextAction =
    decision.status === "blocked"
      ? "Revise the plan before execution; at least one reject/blocker was recorded."
      : decision.status === "needs-quorum"
        ? "Continue deliberation until quorum is met."
      : nativeGit.recordCount > 0
        ? "Review native-git changes and commit with git-master when the work is ready."
        : decision.status === "approved"
          ? "Proceed to execution if the user accepts the recommendation."
          : "Run /deliberate <problem-or-plan> to create the first Republic ledger."

  return [
    "OMO Republic Status",
    "",
    `Repository: ${report.repository.repoRoot}`,
    `Git common dir: ${report.repository.gitCommonDir}`,
    `Generated: ${report.generatedAt}`,
    "",
    "Republic Ledger",
    `Records: ${republic.recordCount}`,
    `Deliberations: ${formatList(republic.deliberationIDs)}`,
    `Phases: ${formatCounter(republic.phases)}`,
    `Chambers: ${formatCounter(republic.chambers)}`,
    `Seats: ${formatList(republic.seats)}`,
    `Agents: ${formatCounter(republic.agents)}`,
    `Votes: ${voteLine}`,
    `Average confidence: ${republic.averageConfidence ?? "n/a"}`,
    `Decision: ${decision.status} (${decision.reason})`,
    `Blocked: ${republic.blocked ? "yes" : "no"}`,
    `Files: ${formatList(republic.files)}`,
    republic.latestSummary ? `Latest: ${republic.latestSummary}` : "Latest: none",
    "",
    "Republic Commons",
    `Messages: ${commons.messageCount}`,
    `Channels: ${formatCounter(commons.channels)}`,
    `Phases: ${formatCounter(commons.phases)}`,
    `Authors: ${formatCounter(commons.authors)}`,
    `Agents: ${formatCounter(commons.agents)}`,
    `Types: ${formatCounter(commons.messageTypes)}`,
    `Targeted messages: ${commons.targetedMessages}`,
    `Referenced messages: ${commons.referencedMessages}`,
    `Files: ${formatList(commons.files)}`,
    commons.latestContent ? `Latest: ${commons.latestContent}` : "Latest: none",
    "",
    "Native Git Audit",
    `Records: ${nativeGit.recordCount}`,
    `Tools: ${formatCounter(nativeGit.tools)}`,
    `Agents: ${formatCounter(nativeGit.agents)}`,
    `Models: ${formatCounter(nativeGit.models)}`,
    `Categories: ${formatCounter(nativeGit.categories)}`,
    `Sessions: ${formatCounter(nativeGit.sessions)}`,
    `Files: ${formatList(nativeGit.files)}`,
    nativeGit.latestSummary ? `Latest: ${nativeGit.latestSummary}` : "Latest: none",
    "",
    `Next action: ${nextAction}`,
  ].join("\n")
}

export async function republicStatus(options: RepublicStatusOptions = {}): Promise<number> {
  const report = buildRepublicStatusReport(options)
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatRepublicStatusReport(report))
  }

  return report.repository ? 0 : 1
}
