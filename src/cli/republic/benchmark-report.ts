import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { getNativeGitStatus, readRepublicTeamManifest } from "../../shared/git-worktree"
import { buildRepublicStatusReport, type RepublicStatusReport } from "./status"

export interface RepublicBenchmarkRunInput {
  label: string
  directory: string
  deliberationId?: string
}

export interface RepublicBenchmarkOptions {
  runs: RepublicBenchmarkRunInput[]
  acceptance?: RepublicBenchmarkAcceptanceInput[]
  output?: string
  json?: boolean
}

export interface RepublicBenchmarkAcceptanceInput {
  runLabel: string
  name: string
  status: "pass" | "fail" | "warn"
  detail?: string
}

export interface RepublicBenchmarkAcceptanceReport extends RepublicBenchmarkAcceptanceInput {}

export interface RepublicBenchmarkRunReport {
  label: string
  directory: string
  repositoryRoot?: string
  deliberationID?: string
  decision: string
  decisionReason: string
  dirtyFileCount: number
  dirtyFiles: string[]
  nativeGitRecords: number
  ledgerRecords: number
  commonsMessages: number
  contracts: number
  contractWarnings: number
  seats: number
  workgroups: number
  targetedMessages: number
  referencedMessages: number
  tools: Record<string, number>
  agents: Record<string, number>
  acceptance: RepublicBenchmarkAcceptanceReport[]
  latestNativeGitSummary?: string
  latestCommonsMessage?: string
}

export interface RepublicBenchmarkReport {
  generatedAt: string
  runCount: number
  runs: RepublicBenchmarkRunReport[]
}

function countKeys(counter: Record<string, number>): number {
  return Object.keys(counter).length
}

function formatCounter(counter: Record<string, number>): string {
  const entries = Object.entries(counter).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return "none"
  return entries.map(([key, value]) => `${key}=${value}`).join(", ")
}

function formatList(values: string[], limit = 8): string {
  if (values.length === 0) return "none"
  const shown = values.slice(0, limit).join(", ")
  return values.length > limit ? `${shown}, ... (+${values.length - limit} more)` : shown
}

function summarizeRun(
  input: RepublicBenchmarkRunInput,
  status: RepublicStatusReport,
  acceptance: RepublicBenchmarkAcceptanceInput[],
): RepublicBenchmarkRunReport {
  const gitStatus = getNativeGitStatus(input.directory)
  const dirtyFiles = gitStatus?.files ?? []
  const teamManifest = status.repository ? readRepublicTeamManifest(status.repository) : null
  const manifestWorkgroups = new Set(teamManifest?.seats.map((seat) => seat.workgroupID).filter(Boolean) ?? [])

  return {
    label: input.label,
    directory: resolve(input.directory),
    repositoryRoot: status.repository?.repoRoot,
    deliberationID: status.deliberationID,
    decision: status.decision.status,
    decisionReason: status.decision.reason,
    dirtyFileCount: dirtyFiles.length,
    dirtyFiles,
    nativeGitRecords: status.nativeGit.recordCount,
    ledgerRecords: status.republic.recordCount,
    commonsMessages: status.commons.messageCount,
    contracts: status.contractTraceability.contractCount,
    contractWarnings: status.contractTraceability.warningCount,
    seats: teamManifest?.seats.length ?? status.republic.seats.length,
    workgroups: Math.max(countKeys(status.republic.workgroups), manifestWorkgroups.size),
    targetedMessages: status.commons.targetedMessages,
    referencedMessages: status.commons.referencedMessages,
    tools: status.nativeGit.tools,
    agents: status.republic.agents,
    acceptance: acceptance.filter((item) => item.runLabel === input.label),
    latestNativeGitSummary: status.nativeGit.latestSummary,
    latestCommonsMessage: status.commons.latestContent,
  }
}

export function buildRepublicBenchmarkReport(options: RepublicBenchmarkOptions): RepublicBenchmarkReport {
  const acceptance = options.acceptance ?? []
  const runs = options.runs.map((run) => summarizeRun(run, buildRepublicStatusReport({
    directory: run.directory,
    deliberationId: run.deliberationId,
  }), acceptance))

  return {
    generatedAt: new Date().toISOString(),
    runCount: runs.length,
    runs,
  }
}

export function formatRepublicBenchmarkReport(report: RepublicBenchmarkReport): string {
  const lines = [
    "# OMO Republic Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Runs: ${report.runCount}`,
    "",
    "| Run | Decision | Dirty files | Native Git | Ledger | Commons | Contracts | Contract warnings | Seats | Workgroups | Targeted | Referenced |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]

  for (const run of report.runs) {
    lines.push([
      `| ${run.label}`,
      run.decision,
      run.dirtyFileCount,
      run.nativeGitRecords,
      run.ledgerRecords,
      run.commonsMessages,
      run.contracts,
      run.contractWarnings,
      run.seats,
      run.workgroups,
      run.targetedMessages,
      `${run.referencedMessages} |`,
    ].join(" | "))
  }

  const acceptanceItems = report.runs.flatMap((run) => run.acceptance)
  if (acceptanceItems.length > 0) {
    lines.push("")
    lines.push("## Acceptance Checks")
    lines.push("")
    lines.push("| Run | Check | Status | Detail |")
    lines.push("| --- | --- | --- | --- |")
    for (const check of acceptanceItems) {
      lines.push(`| ${check.runLabel} | ${check.name} | ${check.status} | ${check.detail ?? ""} |`)
    }
  }

  lines.push("")
  lines.push("## Run Details")

  for (const run of report.runs) {
    lines.push("")
    lines.push(`### ${run.label}`)
    lines.push("")
    lines.push(`Directory: ${run.directory}`)
    lines.push(`Repository: ${run.repositoryRoot ?? "not a git repository"}`)
    if (run.deliberationID) {
      lines.push(`Deliberation: ${run.deliberationID}`)
    }
    lines.push(`Decision: ${run.decision} (${run.decisionReason})`)
    lines.push(`Dirty files: ${formatList(run.dirtyFiles)}`)
    lines.push(`Native Git tools: ${formatCounter(run.tools)}`)
    lines.push(`Republic agents: ${formatCounter(run.agents)}`)
    lines.push(`Acceptance: ${run.acceptance.length === 0 ? "none" : run.acceptance.map((check) => `${check.name}=${check.status}`).join(", ")}`)
    lines.push(`Latest native-git summary: ${run.latestNativeGitSummary ?? "none"}`)
    lines.push(`Latest commons message: ${run.latestCommonsMessage ?? "none"}`)
  }

  lines.push("")
  lines.push("## Interpretation")
  lines.push("")
  lines.push("Use this report as an evidence index. A stronger governed run should show native-git records plus Republic ledger/Commons activity, targeted or referenced messages for collaboration, contracts for module boundaries, and zero contract traceability warnings before review.")

  return lines.join("\n")
}

export function parseRepublicBenchmarkRun(value: string): RepublicBenchmarkRunInput {
  const separator = value.indexOf("=")
  if (separator === -1) {
    return {
      label: basename(resolve(value)) || "run",
      directory: value,
    }
  }

  const label = value.slice(0, separator).trim()
  const directory = value.slice(separator + 1).trim()
  return {
    label: label || basename(resolve(directory)) || "run",
    directory,
  }
}

export function parseRepublicBenchmarkAcceptance(value: string): RepublicBenchmarkAcceptanceInput {
  const assignment = value.indexOf("=")
  if (assignment === -1) {
    throw new Error("Acceptance must use label:check=pass|fail|warn[:detail]")
  }

  const left = value.slice(0, assignment)
  const right = value.slice(assignment + 1)
  const labelSeparator = left.indexOf(":")
  if (labelSeparator === -1) {
    throw new Error("Acceptance must include a run label before ':'")
  }

  const runLabel = left.slice(0, labelSeparator).trim()
  const name = left.slice(labelSeparator + 1).trim()
  const detailSeparator = right.indexOf(":")
  const status = (detailSeparator === -1 ? right : right.slice(0, detailSeparator)).trim()
  if (status !== "pass" && status !== "fail" && status !== "warn") {
    throw new Error("Acceptance status must be pass, fail, or warn")
  }

  return {
    runLabel,
    name,
    status,
    detail: detailSeparator === -1 ? undefined : right.slice(detailSeparator + 1).trim(),
  }
}

function collectAcceptance(
  value: string,
  previous: RepublicBenchmarkAcceptanceInput[],
): RepublicBenchmarkAcceptanceInput[] {
  return [...previous, parseRepublicBenchmarkAcceptance(value)]
}

function collectRun(value: string, previous: RepublicBenchmarkRunInput[]): RepublicBenchmarkRunInput[] {
  return [...previous, parseRepublicBenchmarkRun(value)]
}

export async function republicBenchmarkReport(options: {
  run?: RepublicBenchmarkRunInput[]
  acceptance?: RepublicBenchmarkAcceptanceInput[]
  output?: string
  json?: boolean
}): Promise<number> {
  const runs = options.run ?? []
  if (runs.length === 0) {
    console.error("Error: provide at least one --run label=path")
    return 1
  }

  const report = buildRepublicBenchmarkReport({ runs, acceptance: options.acceptance })
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicBenchmarkReport(report)

  if (options.output) {
    const outputPath = resolve(options.output)
    const outputDir = dirname(outputPath)
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }
    writeFileSync(outputPath, content + "\n", "utf-8")
  } else {
    console.log(content)
  }

  return 0
}

export const republicBenchmarkRunCollector = collectRun
export const republicBenchmarkAcceptanceCollector = collectAcceptance
