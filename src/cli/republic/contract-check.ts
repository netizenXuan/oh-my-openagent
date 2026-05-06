import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  analyzeRepublicContractTraceability,
  getNativeGitRepository,
  type NativeGitRepository,
  type RepublicContractTraceabilitySummary,
} from "../../shared/git-worktree"

export interface RepublicContractCheckReport {
  generatedAt: string
  repository: NativeGitRepository | null
  strict: boolean
  passed: boolean
  traceability: RepublicContractTraceabilitySummary
}

export interface RepublicContractCheckOptions {
  directory?: string
  strict?: boolean
  output?: string
  json?: boolean
}

function emptyTraceability(): RepublicContractTraceabilitySummary {
  return {
    contractCount: 0,
    warningCount: 0,
    items: [],
  }
}

export function buildRepublicContractCheckReport(options: RepublicContractCheckOptions = {}): RepublicContractCheckReport {
  const directory = options.directory ?? process.cwd()
  const repository = getNativeGitRepository(directory)
  const traceability = repository ? analyzeRepublicContractTraceability(repository) : emptyTraceability()
  const strict = options.strict ?? false

  return {
    generatedAt: new Date().toISOString(),
    repository,
    strict,
    passed: repository !== null && (!strict || traceability.warningCount === 0),
    traceability,
  }
}

function formatList(values: string[], limit = 8): string {
  if (values.length === 0) return "none"
  const shown = values.slice(0, limit).join(", ")
  return values.length > limit ? `${shown}, ... (+${values.length - limit} more)` : shown
}

export function formatRepublicContractCheckReport(report: RepublicContractCheckReport): string {
  if (!report.repository) {
    return "OMO Republic Contract Check\n\nNot inside a git repository. No contract traceability can be read."
  }

  const lines = [
    "# OMO Republic Contract Check",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository.repoRoot}`,
    `Mode: ${report.strict ? "strict" : "advisory"}`,
    `Result: ${report.passed ? "pass" : "fail"}`,
    `Contracts: ${report.traceability.contractCount}`,
    `Warnings: ${report.traceability.warningCount}`,
    "",
    "| Contract | Status | Files | Missing files | Uncovered terms |",
    "| --- | --- | --- | --- | --- |",
  ]

  if (report.traceability.items.length === 0) {
    lines.push("| none | pass | none | none | none |")
  } else {
    for (const item of report.traceability.items) {
      lines.push([
        `| ${item.contractID}`,
        item.status,
        formatList(item.files),
        formatList(item.missingFiles),
        `${formatList(item.uncoveredTerms)} |`,
      ].join(" | "))
    }
  }

  return lines.join("\n")
}

export async function republicContractCheck(options: RepublicContractCheckOptions = {}): Promise<number> {
  const report = buildRepublicContractCheckReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicContractCheckReport(report)

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

  return report.passed ? 0 : 1
}
