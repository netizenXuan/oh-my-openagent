import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { buildRepublicStatusReport, type RepublicStatusReport } from "./status"

export type RepublicDoctorStatus = "pass" | "warn" | "fail"

export interface RepublicDoctorCheck {
  name: string
  status: RepublicDoctorStatus
  detail: string
}

export interface RepublicDoctorReport {
  generatedAt: string
  directory: string
  strict: boolean
  healthy: boolean
  checks: RepublicDoctorCheck[]
  status: RepublicStatusReport
}

export interface RepublicDoctorOptions {
  directory?: string
  deliberationId?: string
  strict?: boolean
  output?: string
  json?: boolean
}

function addCheck(checks: RepublicDoctorCheck[], check: RepublicDoctorCheck): void {
  checks.push(check)
}

export function buildRepublicDoctorReport(options: RepublicDoctorOptions = {}): RepublicDoctorReport {
  const directory = resolve(options.directory ?? process.cwd())
  const status = buildRepublicStatusReport({
    directory,
    deliberationId: options.deliberationId,
  })
  const strict = options.strict ?? false
  const checks: RepublicDoctorCheck[] = []

  addCheck(checks, {
    name: "git-repository",
    status: status.repository ? "pass" : "fail",
    detail: status.repository
      ? `Repository root: ${status.repository.repoRoot}.`
      : "No git repository found from the selected directory.",
  })

  if (status.repository) {
    addCheck(checks, {
      name: "native-git-audit",
      status: "pass",
      detail: `Native-git records: ${status.nativeGit.recordCount}.`,
    })
    addCheck(checks, {
      name: "republic-ledger",
      status: status.republic.recordCount > 0 ? "pass" : "warn",
      detail: `Republic ledger records: ${status.republic.recordCount}.`,
    })
    addCheck(checks, {
      name: "republic-commons",
      status: status.commons.messageCount > 0 ? "pass" : "warn",
      detail: `Commons messages: ${status.commons.messageCount}; targeted=${status.commons.targetedMessages}; referenced=${status.commons.referencedMessages}.`,
    })
    addCheck(checks, {
      name: "scheduler-queue",
      status: status.schedulerQueue.pending > 0 || status.schedulerQueue.failed > 0 ? "warn" : "pass",
      detail: `pending=${status.schedulerQueue.pending}; queued=${status.schedulerQueue.queued}; dispatched=${status.schedulerQueue.dispatched}; failed=${status.schedulerQueue.failed}.`,
    })
    addCheck(checks, {
      name: "contract-traceability",
      status: status.contractTraceability.warningCount > 0 ? "warn" : "pass",
      detail: `contracts=${status.contractTraceability.contractCount}; warnings=${status.contractTraceability.warningCount}.`,
    })
  }

  const failures = checks.filter((check) => check.status === "fail").length
  const warnings = checks.filter((check) => check.status === "warn").length
  return {
    generatedAt: new Date().toISOString(),
    directory,
    strict,
    healthy: failures === 0 && (!strict || warnings === 0),
    checks,
    status,
  }
}

export function formatRepublicDoctorReport(report: RepublicDoctorReport): string {
  const lines = [
    "# OMO Republic Doctor",
    "",
    `Generated: ${report.generatedAt}`,
    `Directory: ${report.directory}`,
    `Repository: ${report.status.repository?.repoRoot ?? "not a git repository"}`,
    `Mode: ${report.strict ? "strict" : "advisory"}`,
    `Result: ${report.healthy ? "healthy" : "attention-required"}`,
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
    ...report.checks.map((check) => `| ${check.name} | ${check.status} | ${check.detail.replace(/\|/g, "\\|")} |`),
    "",
    "## Next Action",
    "",
    report.healthy
      ? "No blocking Republic health issues were detected."
      : "Review failed checks and warnings before assigning weak-model seats or running a governed execution.",
  ]
  return lines.join("\n")
}

export async function republicDoctor(options: RepublicDoctorOptions = {}): Promise<number> {
  const report = buildRepublicDoctorReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicDoctorReport(report)

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

  return report.healthy ? 0 : 1
}
