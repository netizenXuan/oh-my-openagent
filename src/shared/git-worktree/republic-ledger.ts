import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { NativeGitRepository } from "./native-git"

export interface RepublicLedgerRecord {
  version?: number
  timestamp?: string
  repoRoot?: string
  deliberationID: string
  phase: string
  chamber?: string
  seatID?: string
  role?: string
  agent?: string
  model?: string
  sessionID?: string
  callID?: string
  workgroupID?: string
  module?: string
  taskID?: string
  dependsOn?: string[]
  supervisorSeatID?: string
  status?: string
  promptHash?: string
  inputBriefHash?: string
  vote?: string
  confidence?: number
  relatedCommit?: string
  files?: string[]
  summary?: string
}

export interface RepublicVoteSummary {
  approve: number
  revise: number
  reject: number
  abstain: number
  other: number
}

export interface RepublicCommonsMessage {
  version?: number
  timestamp?: string
  repoRoot?: string
  messageID?: string
  deliberationID: string
  channel: string
  phase: string
  round?: number
  authorSeatID: string
  authorAgent?: string
  authorRole?: string
  targetSeatID?: string
  workgroupID?: string
  module?: string
  taskID?: string
  dependsOn?: string[]
  supervisorSeatID?: string
  status?: string
  messageType:
    | "proposal"
    | "question"
    | "answer"
    | "objection"
    | "revision"
    | "handoff"
    | "consensus"
    | "contract"
    | "note"
    | "status"
    | "intervention"
    | "dependency-blocked"
    | "supervisor-policy"
  references?: string[]
  files?: string[]
  confidence?: number
  content: string
}

export interface RepublicCommonsSummary {
  deliberationID?: string
  messageCount: number
  channels: Record<string, number>
  phases: Record<string, number>
  authors: Record<string, number>
  agents: Record<string, number>
  workgroups: Record<string, number>
  modules: Record<string, number>
  tasks: string[]
  messageTypes: Record<string, number>
  targetedMessages: number
  referencedMessages: number
  files: string[]
  latestTimestamp?: string
  latestContent?: string
}

export interface RepublicLedgerSummary {
  deliberationID?: string
  recordCount: number
  deliberationIDs: string[]
  phases: Record<string, number>
  chambers: Record<string, number>
  agents: Record<string, number>
  workgroups: Record<string, number>
  modules: Record<string, number>
  tasks: string[]
  seats: string[]
  votes: RepublicVoteSummary
  averageConfidence: number | null
  files: string[]
  latestTimestamp?: string
  latestSummary?: string
  blocked: boolean
}

export interface RepublicDecisionPolicy {
  quorum: number
  supermajority: number
  vetoOnBlocker: boolean
}

export interface RepublicDecision {
  status: "no-records" | "needs-quorum" | "blocked" | "approved" | "revise"
  approvalRatio: number | null
  decisiveVotes: number
  reason: string
}

export interface RepublicContractTraceabilityItem {
  contractID: string
  path: string
  files: string[]
  terms: string[]
  coveredTerms: string[]
  uncoveredTerms: string[]
  missingFiles: string[]
  status: "pass" | "warning"
}

export interface RepublicContractTraceabilitySummary {
  contractCount: number
  warningCount: number
  items: RepublicContractTraceabilityItem[]
}

export type RepublicSchedulerQueueStatus = "queued" | "dispatched" | "skipped" | "failed"

export interface RepublicSchedulerQueueRecord {
  version?: number
  timestamp?: string
  repoRoot?: string
  dispatchID?: string
  queueType: "seat-response" | "supervisor-review"
  status: RepublicSchedulerQueueStatus
  reason?: string
  deliberationID: string
  phase?: string
  sourceMessageID?: string
  sourceMessageType?: RepublicCommonsMessage["messageType"]
  targetSeatID?: string
  requestedAgent?: string
  runtimeAgent?: string
  taskID?: string
  workgroupID?: string
  module?: string
  files?: string[]
  references?: string[]
  summary?: string
}

export interface RepublicSchedulerQueueSummary {
  recordCount: number
  pending: number
  queued: number
  dispatched: number
  skipped: number
  failed: number
  statuses: Record<string, number>
  queueTypes: Record<string, number>
  targetSeats: Record<string, number>
  requestedAgents: Record<string, number>
  runtimeAgents: Record<string, number>
  latestTimestamp?: string
  latestSummary?: string
}

export const DEFAULT_REPUBLIC_DECISION_POLICY: RepublicDecisionPolicy = {
  quorum: 4,
  supermajority: 0.67,
  vetoOnBlocker: true,
}

export function sanitizeRepublicDeliberationID(deliberationID: string): string {
  const sanitized = deliberationID.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return sanitized || "deliberation"
}

export function getRepublicLedgerPath(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "ledger.jsonl")
}

export function getRepublicCommonsPath(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "commons.jsonl")
}

export function getRepublicAgentDocPath(repository: NativeGitRepository, seatID: string): string {
  return join(repository.gitCommonDir, "omo", "republic", "agents", `${sanitizeRepublicDeliberationID(seatID)}.md`)
}

export function getRepublicContractPath(repository: NativeGitRepository, workgroupID: string): string {
  return join(repository.gitCommonDir, "omo", "republic", "contracts", `${sanitizeRepublicDeliberationID(workgroupID)}.md`)
}

export function getRepublicSchedulerQueuePath(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "scheduler", "queue.jsonl")
}

function getRepublicContractsDir(repository: NativeGitRepository): string {
  return join(repository.gitCommonDir, "omo", "republic", "contracts")
}

function incrementCounter(counter: Record<string, number>, key: string | undefined): void {
  if (!key) return
  counter[key] = (counter[key] ?? 0) + 1
}

function parseRepublicLedgerLine(line: string): RepublicLedgerRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<RepublicLedgerRecord>
    if (typeof parsed.deliberationID !== "string" || typeof parsed.phase !== "string") {
      return null
    }

    return parsed as RepublicLedgerRecord
  } catch {
    return null
  }
}

function parseRepublicCommonsLine(line: string): RepublicCommonsMessage | null {
  try {
    const parsed = JSON.parse(line) as Partial<RepublicCommonsMessage>
    if (
      typeof parsed.deliberationID !== "string" ||
      typeof parsed.channel !== "string" ||
      typeof parsed.phase !== "string" ||
      typeof parsed.authorSeatID !== "string" ||
      typeof parsed.messageType !== "string" ||
      typeof parsed.content !== "string"
    ) {
      return null
    }

    return parsed as RepublicCommonsMessage
  } catch {
    return null
  }
}

function parseRepublicSchedulerQueueLine(line: string): RepublicSchedulerQueueRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<RepublicSchedulerQueueRecord>
    if (
      typeof parsed.deliberationID !== "string" ||
      typeof parsed.queueType !== "string" ||
      typeof parsed.status !== "string"
    ) {
      return null
    }

    return parsed as RepublicSchedulerQueueRecord
  } catch {
    return null
  }
}

function createRepublicMessageID(message: RepublicCommonsMessage, timestamp: string): string {
  const base = [
    sanitizeRepublicDeliberationID(message.deliberationID),
    message.channel,
    message.authorSeatID,
    message.messageType,
    timestamp,
  ].join("-")
  return sanitizeRepublicDeliberationID(base).slice(0, 120)
}

function formatCommonsDocEntry(message: RepublicCommonsMessage, timestamp: string): string {
  const lines = [
    `## ${timestamp} ${message.messageType} ${message.channel}/${message.phase}`,
    "",
    `- message: ${message.messageID ?? "pending"}`,
    `- deliberation: ${sanitizeRepublicDeliberationID(message.deliberationID)}`,
    `- author: ${message.authorSeatID}`,
  ]

  if (message.targetSeatID) lines.push(`- target: ${message.targetSeatID}`)
  if (message.workgroupID) lines.push(`- workgroup: ${message.workgroupID}`)
  if (message.module) lines.push(`- module: ${message.module}`)
  if (message.taskID) lines.push(`- task: ${message.taskID}`)
  if ((message.dependsOn?.length ?? 0) > 0) lines.push(`- depends_on: ${message.dependsOn!.join(", ")}`)
  if ((message.files?.length ?? 0) > 0) lines.push(`- files: ${message.files!.join(", ")}`)
  if ((message.references?.length ?? 0) > 0) lines.push(`- references: ${message.references!.join(", ")}`)

  lines.push("", message.content.trim(), "")
  return `${lines.join("\n")}\n`
}

function appendRepublicAgentDoc(repository: NativeGitRepository, seatID: string, message: RepublicCommonsMessage, timestamp: string): void {
  const docPath = getRepublicAgentDocPath(repository, seatID)
  mkdirSync(dirname(docPath), { recursive: true })
  if (!existsSync(docPath)) {
    writeFileSync(docPath, `# Republic Agent Doc: ${sanitizeRepublicDeliberationID(seatID)}\n\n`, "utf-8")
  }
  appendFileSync(docPath, formatCommonsDocEntry(message, timestamp), "utf-8")
}

function createRepublicDispatchID(record: RepublicSchedulerQueueRecord, timestamp: string): string {
  const base = [
    sanitizeRepublicDeliberationID(record.deliberationID),
    record.queueType,
    record.targetSeatID ?? "broadcast",
    record.sourceMessageID ?? timestamp,
    record.status,
  ].join("-")
  return sanitizeRepublicDeliberationID(base).slice(0, 140)
}

export function readRepublicLedgerRecords(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicLedgerRecord[] {
  const ledgerPath = getRepublicLedgerPath(repository)
  if (!existsSync(ledgerPath)) {
    return []
  }

  const sanitizedID = deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined
  return readFileSync(ledgerPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRepublicLedgerLine)
    .filter((record): record is RepublicLedgerRecord => record !== null)
    .filter((record) => !sanitizedID || sanitizeRepublicDeliberationID(record.deliberationID) === sanitizedID)
}

export function appendRepublicCommonsMessage(
  repository: NativeGitRepository,
  message: RepublicCommonsMessage,
): string {
  const commonsPath = getRepublicCommonsPath(repository)
  mkdirSync(dirname(commonsPath), { recursive: true })
  const timestamp = new Date().toISOString()
  const normalizedMessage = {
    version: 1,
    timestamp,
    repoRoot: repository.repoRoot,
    ...message,
    deliberationID: sanitizeRepublicDeliberationID(message.deliberationID),
    messageID: message.messageID ?? createRepublicMessageID(message, timestamp),
  }
  appendFileSync(
    commonsPath,
    JSON.stringify(normalizedMessage) + "\n",
    "utf-8",
  )
  appendRepublicAgentDoc(repository, normalizedMessage.authorSeatID, normalizedMessage, timestamp)
  if (normalizedMessage.targetSeatID && normalizedMessage.targetSeatID !== normalizedMessage.authorSeatID) {
    appendRepublicAgentDoc(repository, normalizedMessage.targetSeatID, normalizedMessage, timestamp)
  }
  return commonsPath
}

export function appendRepublicSchedulerQueueRecord(
  repository: NativeGitRepository,
  record: RepublicSchedulerQueueRecord,
): string {
  const queuePath = getRepublicSchedulerQueuePath(repository)
  mkdirSync(dirname(queuePath), { recursive: true })
  const timestamp = new Date().toISOString()
  const normalizedRecord = {
    ...record,
    version: 1,
    timestamp,
    repoRoot: repository.repoRoot,
    deliberationID: sanitizeRepublicDeliberationID(record.deliberationID),
    dispatchID: record.dispatchID ?? createRepublicDispatchID(record, timestamp),
  }
  appendFileSync(queuePath, JSON.stringify(normalizedRecord) + "\n", "utf-8")
  return queuePath
}

export function readRepublicSchedulerQueueRecords(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicSchedulerQueueRecord[] {
  const queuePath = getRepublicSchedulerQueuePath(repository)
  if (!existsSync(queuePath)) {
    return []
  }

  const sanitizedID = deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined
  return readFileSync(queuePath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRepublicSchedulerQueueLine)
    .filter((record): record is RepublicSchedulerQueueRecord => record !== null)
    .filter((record) => !sanitizedID || sanitizeRepublicDeliberationID(record.deliberationID) === sanitizedID)
}

export function summarizeRepublicSchedulerQueueRecords(
  records: RepublicSchedulerQueueRecord[],
): RepublicSchedulerQueueSummary {
  const statuses: Record<string, number> = {}
  const queueTypes: Record<string, number> = {}
  const targetSeats: Record<string, number> = {}
  const requestedAgents: Record<string, number> = {}
  const runtimeAgents: Record<string, number> = {}
  const latestByDispatchID = new Map<string, RepublicSchedulerQueueRecord>()
  let latestTimestamp: string | undefined
  let latestSummary: string | undefined

  for (const record of records) {
    incrementCounter(statuses, record.status)
    incrementCounter(queueTypes, record.queueType)
    incrementCounter(targetSeats, record.targetSeatID)
    incrementCounter(requestedAgents, record.requestedAgent)
    incrementCounter(runtimeAgents, record.runtimeAgent)
    if (record.dispatchID) {
      const current = latestByDispatchID.get(record.dispatchID)
      if (!current || String(record.timestamp ?? "") >= String(current.timestamp ?? "")) {
        latestByDispatchID.set(record.dispatchID, record)
      }
    }
    if (record.timestamp && (!latestTimestamp || record.timestamp >= latestTimestamp)) {
      latestTimestamp = record.timestamp
      latestSummary = record.summary
    }
  }

  return {
    recordCount: records.length,
    pending: Array.from(latestByDispatchID.values()).filter((record) => record.status === "queued").length,
    queued: statuses.queued ?? 0,
    dispatched: statuses.dispatched ?? 0,
    skipped: statuses.skipped ?? 0,
    failed: statuses.failed ?? 0,
    statuses,
    queueTypes,
    targetSeats,
    requestedAgents,
    runtimeAgents,
    latestTimestamp,
    latestSummary,
  }
}

export function summarizeRepublicSchedulerQueue(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicSchedulerQueueSummary {
  return summarizeRepublicSchedulerQueueRecords(readRepublicSchedulerQueueRecords(repository, deliberationID))
}

export function readRepublicCommonsMessages(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicCommonsMessage[] {
  const commonsPath = getRepublicCommonsPath(repository)
  if (!existsSync(commonsPath)) {
    return []
  }

  const sanitizedID = deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined
  return readFileSync(commonsPath, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseRepublicCommonsLine)
    .filter((message): message is RepublicCommonsMessage => message !== null)
    .filter((message) => !sanitizedID || sanitizeRepublicDeliberationID(message.deliberationID) === sanitizedID)
}

export function summarizeRepublicCommonsMessages(
  messages: RepublicCommonsMessage[],
  deliberationID?: string,
): RepublicCommonsSummary {
  const channels: Record<string, number> = {}
  const phases: Record<string, number> = {}
  const authors: Record<string, number> = {}
  const agents: Record<string, number> = {}
  const workgroups: Record<string, number> = {}
  const modules: Record<string, number> = {}
  const tasks = new Set<string>()
  const messageTypes: Record<string, number> = {}
  const files = new Set<string>()
  let targetedMessages = 0
  let referencedMessages = 0
  let latestTimestamp: string | undefined
  let latestContent: string | undefined

  for (const message of messages) {
    incrementCounter(channels, message.channel)
    incrementCounter(phases, message.phase)
    incrementCounter(authors, message.authorSeatID)
    incrementCounter(agents, message.authorAgent)
    incrementCounter(workgroups, message.workgroupID)
    incrementCounter(modules, message.module)
    if (message.taskID) tasks.add(message.taskID)
    incrementCounter(messageTypes, message.messageType)
    if (message.targetSeatID) targetedMessages += 1
    if ((message.references?.length ?? 0) > 0) referencedMessages += 1
    for (const file of message.files ?? []) {
      files.add(file)
    }

    if (message.timestamp && (!latestTimestamp || message.timestamp >= latestTimestamp)) {
      latestTimestamp = message.timestamp
      latestContent = message.content
    }
  }

  return {
    deliberationID: deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined,
    messageCount: messages.length,
    channels,
    phases,
    authors,
    agents,
    workgroups,
    modules,
    tasks: Array.from(tasks).sort(),
    messageTypes,
    targetedMessages,
    referencedMessages,
    files: Array.from(files).sort(),
    latestTimestamp,
    latestContent,
  }
}

export function summarizeRepublicCommons(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicCommonsSummary {
  return summarizeRepublicCommonsMessages(readRepublicCommonsMessages(repository, deliberationID), deliberationID)
}

export function readRepublicAgentDoc(repository: NativeGitRepository, seatID: string): string {
  const docPath = getRepublicAgentDocPath(repository, seatID)
  return existsSync(docPath) ? readFileSync(docPath, "utf-8") : ""
}

export function readRepublicInboxMessages(
  repository: NativeGitRepository,
  options: {
    seatID: string
    deliberationID?: string
    workgroupID?: string
    module?: string
    limit?: number
  },
): RepublicCommonsMessage[] {
  const limit = options.limit && options.limit > 0 ? options.limit : 10
  const seatID = sanitizeRepublicDeliberationID(options.seatID)
  const messages = readRepublicCommonsMessages(repository, options.deliberationID)
  const relevant = messages.filter((message) => {
    if (message.authorSeatID === seatID) {
      return false
    }
    if (message.targetSeatID === seatID) {
      return true
    }
    if (options.workgroupID && message.workgroupID === options.workgroupID) {
      return true
    }
    if (options.module && message.module === options.module) {
      return true
    }
    return ["question", "objection", "handoff", "intervention", "dependency-blocked", "supervisor-policy"].includes(message.messageType)
  })

  return relevant.slice(-limit).reverse()
}

export function writeRepublicContract(
  repository: NativeGitRepository,
  input: {
    workgroupID: string
    module?: string
    title: string
    content: string
    authorSeatID: string
    status?: string
    files?: string[]
  },
): string {
  const contractPath = getRepublicContractPath(repository, input.workgroupID)
  mkdirSync(dirname(contractPath), { recursive: true })
  const timestamp = new Date().toISOString()
  const existing = existsSync(contractPath) ? readFileSync(contractPath, "utf-8") : `# Workgroup Contract: ${sanitizeRepublicDeliberationID(input.workgroupID)}\n\n`
  const entry = [
    `## ${timestamp} ${input.title}`,
    "",
    `- author: ${input.authorSeatID}`,
    `- status: ${input.status ?? "proposed"}`,
    input.module ? `- module: ${input.module}` : undefined,
    input.files?.length ? `- files: ${input.files.join(", ")}` : undefined,
    "",
    input.content.trim(),
    "",
  ].filter((line): line is string => typeof line === "string").join("\n")

  writeFileSync(contractPath, `${existing.trimEnd()}\n\n${entry}\n`, "utf-8")
  return contractPath
}

function extractContractFiles(content: string): string[] {
  const files = new Set<string>()
  let inGovernedFilesList = false

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*files:\s*(.+)$/i)
    if (match?.[1]) {
      for (const file of match[1].split(",")) {
        const normalized = file.trim().replace(/\\/g, "/")
        if (normalized.length > 0) {
          files.add(normalized)
        }
      }
      continue
    }

    if (/^\s*(files governed|governed files|files)\s*:\s*$/i.test(line)) {
      inGovernedFilesList = true
      continue
    }

    if (inGovernedFilesList) {
      const governedFile = line.match(/^\s*-\s*([^\s]+\.[A-Za-z0-9]+)\s*$/)
      if (governedFile?.[1]) {
        files.add(governedFile[1].trim().replace(/\\/g, "/"))
        continue
      }

      if (/^\s*[A-Za-z][A-Za-z\s-]*:\s*$/.test(line)) {
        inGovernedFilesList = false
      }
    }
  }
  return Array.from(files).sort()
}

const CONTRACT_TERM_STOP_WORDS = new Set([
  "api",
  "body",
  "contract",
  "contracts",
  "data",
  "docs",
  "domain",
  "error",
  "exports",
  "failure",
  "file",
  "files",
  "from",
  "function",
  "generated",
  "implementation",
  "module",
  "order",
  "orders",
  "package",
  "request",
  "response",
  "status",
  "success",
  "test",
  "tests",
  "the",
  "title",
  "type",
  "workgroup",
])

function isTraceableContractTerm(term: string): boolean {
  const normalized = term.trim()
  if (normalized.length < 3 || normalized.length > 80) {
    return false
  }
  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes(".")) {
    return false
  }
  if (CONTRACT_TERM_STOP_WORDS.has(normalized.toLowerCase())) {
    return false
  }
  return /_/.test(normalized)
    || /[a-z][A-Z]/.test(normalized)
    || /^[a-z][a-z0-9-]+$/.test(normalized)
}

function extractContractTerms(content: string): string[] {
  const terms = new Set<string>()
  for (const pattern of [/`([^`\r\n]{3,80})`/g, /"([^"\r\n]{3,80})"/g]) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const term = match[1]?.trim()
      if (term && isTraceableContractTerm(term)) {
        terms.add(term)
      }
    }
  }

  const identifierSource = content
    .split(/\r?\n/)
    .filter((line) => !/\bformula\s*:/i.test(line))
    .join("\n")
  let identifierMatch: RegExpExecArray | null
  const identifierPattern = /\b[A-Za-z][A-Za-z0-9_]{2,}\b/g
  while ((identifierMatch = identifierPattern.exec(identifierSource)) !== null) {
    const term = identifierMatch[0]
    const looksLikeCodeIdentifier = /_/.test(term) || /[a-z][A-Z]/.test(term)
    if (looksLikeCodeIdentifier && isTraceableContractTerm(term)) {
      terms.add(term)
    }
  }

  return Array.from(terms).sort((left, right) => left.localeCompare(right))
}

export function analyzeRepublicContractTraceability(repository: NativeGitRepository): RepublicContractTraceabilitySummary {
  const contractsDir = getRepublicContractsDir(repository)
  if (!existsSync(contractsDir)) {
    return { contractCount: 0, warningCount: 0, items: [] }
  }

  const items: RepublicContractTraceabilityItem[] = []
  for (const entry of readdirSync(contractsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue
    }

    const contractPath = join(contractsDir, entry.name)
    const content = readFileSync(contractPath, "utf-8")
    const files = extractContractFiles(content)
    const terms = extractContractTerms(content)
    const fileTexts = files.flatMap((file) => {
      const absolutePath = join(repository.repoRoot, file)
      if (!existsSync(absolutePath)) {
        return []
      }
      try {
        return [readFileSync(absolutePath, "utf-8")]
      } catch {
        return []
      }
    })
    const missingFiles = files.filter((file) => !existsSync(join(repository.repoRoot, file)))
    const coveredTerms = terms.filter((term) => fileTexts.some((text) => text.includes(term)))
    const uncoveredTerms = terms.filter((term) => !coveredTerms.includes(term))
    const status = missingFiles.length > 0 || uncoveredTerms.length > 0 ? "warning" : "pass"

    items.push({
      contractID: entry.name.slice(0, -3),
      path: contractPath,
      files,
      terms,
      coveredTerms,
      uncoveredTerms,
      missingFiles,
      status,
    })
  }

  return {
    contractCount: items.length,
    warningCount: items.filter((item) => item.status === "warning").length,
    items: items.sort((left, right) => left.contractID.localeCompare(right.contractID)),
  }
}

export function summarizeRepublicLedgerRecords(
  records: RepublicLedgerRecord[],
  deliberationID?: string,
): RepublicLedgerSummary {
  const phases: Record<string, number> = {}
  const chambers: Record<string, number> = {}
  const agents: Record<string, number> = {}
  const workgroups: Record<string, number> = {}
  const modules: Record<string, number> = {}
  const seats = new Set<string>()
  const tasks = new Set<string>()
  const deliberationIDs = new Set<string>()
  const files = new Set<string>()
  const votes: RepublicVoteSummary = {
    approve: 0,
    revise: 0,
    reject: 0,
    abstain: 0,
    other: 0,
  }
  let confidenceTotal = 0
  let confidenceCount = 0
  let latestTimestamp: string | undefined
  let latestSummary: string | undefined
  let blocked = false

  for (const record of records) {
    const sanitizedID = sanitizeRepublicDeliberationID(record.deliberationID)
    deliberationIDs.add(sanitizedID)
    incrementCounter(phases, record.phase)
    incrementCounter(chambers, record.chamber)
    incrementCounter(agents, record.agent)
    incrementCounter(workgroups, record.workgroupID)
    incrementCounter(modules, record.module)
    if (record.seatID) seats.add(record.seatID)
    if (record.taskID) tasks.add(record.taskID)
    for (const file of record.files ?? []) {
      files.add(file)
    }

    if (typeof record.confidence === "number" && Number.isFinite(record.confidence)) {
      confidenceTotal += record.confidence
      confidenceCount += 1
    }

    const normalizedVote = record.vote?.toLowerCase()
    if (normalizedVote === "approve") {
      votes.approve += 1
    } else if (normalizedVote === "revise") {
      votes.revise += 1
    } else if (normalizedVote === "reject") {
      votes.reject += 1
    } else if (normalizedVote === "abstain") {
      votes.abstain += 1
    } else if (normalizedVote) {
      votes.other += 1
    }

    if (normalizedVote === "reject" || record.summary?.toLowerCase().includes("blocker")) {
      blocked = true
    }

    if (record.timestamp && (!latestTimestamp || record.timestamp > latestTimestamp)) {
      latestTimestamp = record.timestamp
      latestSummary = record.summary
    }
  }

  return {
    deliberationID: deliberationID ? sanitizeRepublicDeliberationID(deliberationID) : undefined,
    recordCount: records.length,
    deliberationIDs: Array.from(deliberationIDs).sort(),
    phases,
    chambers,
    agents,
    workgroups,
    modules,
    tasks: Array.from(tasks).sort(),
    seats: Array.from(seats).sort(),
    votes,
    averageConfidence: confidenceCount > 0 ? Number((confidenceTotal / confidenceCount).toFixed(3)) : null,
    files: Array.from(files).sort(),
    latestTimestamp,
    latestSummary,
    blocked,
  }
}

export function summarizeRepublicLedger(
  repository: NativeGitRepository,
  deliberationID?: string,
): RepublicLedgerSummary {
  return summarizeRepublicLedgerRecords(readRepublicLedgerRecords(repository, deliberationID), deliberationID)
}

export function evaluateRepublicDecision(
  summary: RepublicLedgerSummary,
  policy: RepublicDecisionPolicy = DEFAULT_REPUBLIC_DECISION_POLICY,
): RepublicDecision {
  if (summary.recordCount === 0) {
    return {
      status: "no-records",
      approvalRatio: null,
      decisiveVotes: 0,
      reason: "No Republic ledger records exist yet.",
    }
  }

  if (summary.blocked && policy.vetoOnBlocker) {
    return {
      status: "blocked",
      approvalRatio: null,
      decisiveVotes: summary.votes.reject,
      reason: "At least one reject/blocker was recorded and veto_on_blocker is enabled.",
    }
  }

  const seatRecordCount = summary.seats.length
  if (seatRecordCount < policy.quorum) {
    return {
      status: "needs-quorum",
      approvalRatio: null,
      decisiveVotes: seatRecordCount,
      reason: `Only ${seatRecordCount} seat record${seatRecordCount === 1 ? "" : "s"} found; quorum requires ${policy.quorum}.`,
    }
  }

  const decisiveVotes = summary.votes.approve + summary.votes.revise + summary.votes.reject
  if (decisiveVotes === 0) {
    return {
      status: "revise",
      approvalRatio: null,
      decisiveVotes,
      reason: "No approve/revise/reject votes were recorded.",
    }
  }

  const approvalRatio = Number((summary.votes.approve / decisiveVotes).toFixed(3))
  if (approvalRatio >= policy.supermajority) {
    return {
      status: "approved",
      approvalRatio,
      decisiveVotes,
      reason: `Approval ratio ${approvalRatio} meets supermajority threshold ${policy.supermajority}.`,
    }
  }

  return {
    status: "revise",
    approvalRatio,
    decisiveVotes,
    reason: `Approval ratio ${approvalRatio} is below supermajority threshold ${policy.supermajority}.`,
  }
}

export function getRepublicDeliberationDir(
  repository: NativeGitRepository,
  deliberationID: string,
): string {
  return join(
    repository.gitCommonDir,
    "omo",
    "republic",
    "deliberations",
    sanitizeRepublicDeliberationID(deliberationID),
  )
}

export function appendRepublicLedgerRecord(
  repository: NativeGitRepository,
  record: RepublicLedgerRecord,
): string {
  const ledgerPath = getRepublicLedgerPath(repository)
  mkdirSync(dirname(ledgerPath), { recursive: true })
  appendFileSync(
    ledgerPath,
    JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      repoRoot: repository.repoRoot,
      ...record,
      deliberationID: sanitizeRepublicDeliberationID(record.deliberationID),
    }) + "\n",
    "utf-8",
  )
  return ledgerPath
}
