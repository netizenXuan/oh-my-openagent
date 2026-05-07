import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  appendRepublicCommonsMessage,
  getNativeGitRepository,
  readRepublicCommonsMessages,
  sanitizeRepublicDeliberationID,
  summarizeRepublicCommonsMessages,
  type NativeGitRepository,
  type RepublicCommonsMessage,
} from "../../shared/git-worktree"

export type RepublicEvaluatorResult = "pass" | "warn" | "fail"

export interface RepublicEvaluationReport {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID: string
  evaluatorSeatID: string
  targetMessageID?: string
  promptPath?: string
  recordedResult?: RepublicEvaluatorResult
  published: boolean
  messageCount: number
  evidenceFiles: string[]
}

export interface RepublicEvaluationOptions {
  directory?: string
  deliberationId?: string
  evaluatorSeatId?: string
  targetMessageId?: string
  evidenceFile?: string[]
  writePrompt?: boolean
  promptOutput?: string
  result?: RepublicEvaluatorResult
  summary?: string
  output?: string
  json?: boolean
}

function evaluatorPromptDir(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "evaluator", "prompts")
}

function evaluatorPromptPath(
  repository: NativeGitRepository,
  deliberationID: string,
  targetMessageID?: string,
): string {
  const suffix = targetMessageID ? sanitizeRepublicDeliberationID(targetMessageID) : "deliberation"
  return join(evaluatorPromptDir(repository), `${sanitizeRepublicDeliberationID(deliberationID)}-${suffix}.md`)
}

function latestMessages(messages: RepublicCommonsMessage[], limit = 20): RepublicCommonsMessage[] {
  return messages.slice(-limit)
}

function readEvidence(repository: NativeGitRepository, evidenceFiles?: string[]): {
  files: string[]
  sections: string[]
} {
  const files: string[] = []
  const sections: string[] = []
  for (const file of evidenceFiles ?? []) {
    const absolutePath = resolve(repository.repoRoot, file)
    if (!existsSync(absolutePath)) {
      sections.push(`## Evidence: ${file}\n\nMissing file.`)
      continue
    }
    files.push(file)
    const content = readFileSync(absolutePath, "utf-8")
    sections.push([
      `## Evidence: ${file}`,
      "",
      "```",
      content.slice(0, 12000),
      content.length > 12000 ? "\n[truncated]" : "",
      "```",
    ].join("\n"))
  }
  return { files, sections }
}

function formatMessage(message: RepublicCommonsMessage): string {
  return [
    `- id: ${message.messageID ?? "unknown"}`,
    `  type: ${message.messageType}`,
    `  author: ${message.authorSeatID}`,
    message.targetSeatID ? `  target: ${message.targetSeatID}` : undefined,
    message.workgroupID ? `  workgroup: ${message.workgroupID}` : undefined,
    message.module ? `  module: ${message.module}` : undefined,
    message.references?.length ? `  references: ${message.references.join(", ")}` : undefined,
    `  content: ${message.content.replace(/\s+/g, " ").trim().slice(0, 600)}`,
  ].filter((line): line is string => typeof line === "string").join("\n")
}

function buildEvaluatorPrompt(
  repository: NativeGitRepository,
  options: {
    deliberationID: string
    evaluatorSeatID: string
    targetMessageID?: string
    messages: RepublicCommonsMessage[]
    evidenceFiles?: string[]
  },
): string {
  const summary = summarizeRepublicCommonsMessages(options.messages, options.deliberationID)
  const target = options.targetMessageID
    ? options.messages.find((message) => message.messageID === options.targetMessageID)
    : undefined
  const evidence = readEvidence(repository, options.evidenceFiles)
  const lines = [
    "# OMO Republic Semantic Evaluator Prompt",
    "",
    `Repository: ${repository.repoRoot}`,
    `Deliberation: ${options.deliberationID}`,
    `Evaluator seat: ${options.evaluatorSeatID}`,
    options.targetMessageID ? `Target message: ${options.targetMessageID}` : undefined,
    "",
    "Your task is to act as an independent semantic evaluator seat.",
    "Judge whether the current collaboration evidence and implementation satisfy the contract and task intent.",
    "Do not rubber-stamp format compliance. Look for semantic mismatches, missing integration, hidden regressions, and weak-model shortcutting.",
    "",
    "Required output:",
    "- Publish a Republic Commons message with republic_publish.",
    "- Use author_seat_id set to the evaluator seat.",
    "- Use message_type=\"consensus\" for pass, \"revision\" for warn, or \"objection\" for fail.",
    "- Include specific evidence and affected files in the content.",
    "",
    "## Commons Summary",
    "",
    `Messages: ${summary.messageCount}`,
    `Message types: ${JSON.stringify(summary.messageTypes)}`,
    `Authors: ${JSON.stringify(summary.authors)}`,
    "",
    "## Target Message",
    "",
    target ? formatMessage(target) : "No specific target message was selected.",
    "",
    "## Recent Commons Messages",
    "",
    ...latestMessages(options.messages).map(formatMessage),
    "",
    ...evidence.sections,
  ]
  return `${lines.filter((line): line is string => typeof line === "string").join("\n")}\n`
}

function resultMessageType(result: RepublicEvaluatorResult): RepublicCommonsMessage["messageType"] {
  if (result === "pass") return "consensus"
  if (result === "warn") return "revision"
  return "objection"
}

function resultStatus(result: RepublicEvaluatorResult): string {
  if (result === "pass") return "approved"
  if (result === "warn") return "revise"
  return "blocked"
}

export function buildRepublicEvaluationReport(options: RepublicEvaluationOptions = {}): RepublicEvaluationReport {
  const directory = resolve(options.directory ?? process.cwd())
  const repository = getNativeGitRepository(directory)
  const deliberationID = sanitizeRepublicDeliberationID(options.deliberationId ?? "republic")
  const evaluatorSeatID = sanitizeRepublicDeliberationID(options.evaluatorSeatId ?? "validator-seat")

  if (!repository) {
    return {
      generatedAt: new Date().toISOString(),
      repository: null,
      deliberationID,
      evaluatorSeatID,
      targetMessageID: options.targetMessageId,
      published: false,
      messageCount: 0,
      evidenceFiles: options.evidenceFile ?? [],
    }
  }

  const messages = readRepublicCommonsMessages(repository, deliberationID)
  let promptPath: string | undefined
  if (options.writePrompt || options.promptOutput) {
    promptPath = resolve(options.promptOutput ?? evaluatorPromptPath(repository, deliberationID, options.targetMessageId))
    mkdirSync(dirname(promptPath), { recursive: true })
    writeFileSync(promptPath, buildEvaluatorPrompt(repository, {
      deliberationID,
      evaluatorSeatID,
      targetMessageID: options.targetMessageId,
      messages,
      evidenceFiles: options.evidenceFile,
    }), "utf-8")
  }

  let published = false
  if (options.result) {
    appendRepublicCommonsMessage(repository, {
      deliberationID,
      channel: "evaluator",
      phase: "review",
      authorSeatID: evaluatorSeatID,
      targetSeatID: "republic-supervisor",
      messageType: resultMessageType(options.result),
      references: options.targetMessageId ? [options.targetMessageId] : undefined,
      files: options.evidenceFile,
      status: resultStatus(options.result),
      content: options.summary ?? `Semantic evaluator recorded ${options.result}.`,
    })
    published = true
  }

  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID,
    evaluatorSeatID,
    targetMessageID: options.targetMessageId,
    promptPath,
    recordedResult: options.result,
    published,
    messageCount: messages.length,
    evidenceFiles: options.evidenceFile ?? [],
  }
}

export function formatRepublicEvaluationReport(report: RepublicEvaluationReport): string {
  if (!report.repository) {
    return "OMO Republic Evaluator\n\nNot inside a git repository. No semantic evaluation can be prepared."
  }

  return [
    "# OMO Republic Evaluator",
    "",
    `Generated: ${report.generatedAt}`,
    `Repository: ${report.repository.repoRoot}`,
    `Deliberation: ${report.deliberationID}`,
    `Evaluator seat: ${report.evaluatorSeatID}`,
    report.targetMessageID ? `Target message: ${report.targetMessageID}` : undefined,
    report.promptPath ? `Prompt: ${report.promptPath}` : undefined,
    report.recordedResult ? `Recorded result: ${report.recordedResult}` : undefined,
    `Published verdict: ${report.published ? "yes" : "no"}`,
    `Commons messages considered: ${report.messageCount}`,
    report.evidenceFiles.length > 0 ? `Evidence files: ${report.evidenceFiles.join(", ")}` : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n")
}

export async function republicEvaluate(options: RepublicEvaluationOptions = {}): Promise<number> {
  const report = buildRepublicEvaluationReport(options)
  const content = options.json ? JSON.stringify(report, null, 2) : formatRepublicEvaluationReport(report)

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

  if (!report.repository) return 1
  return 0
}
