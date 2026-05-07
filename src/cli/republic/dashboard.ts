import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  getNativeGitRepository,
  readNativeGitAuditRecords,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  readRepublicSchedulerQueueRecords,
  readRepublicSeatState,
  readRepublicTeamManifest,
  readRepublicTeamPhase,
  sanitizeRepublicDeliberationID,
  type NativeGitAuditRecord,
  type NativeGitRepository,
  type RepublicCommonsMessage,
  type RepublicLedgerRecord,
  type RepublicSchedulerQueueRecord,
  type RepublicSeatState,
  type RepublicTeamManifest,
  type RepublicTeamPhaseState,
} from "../../shared/git-worktree"
import { buildRepublicStatusReport, type RepublicStatusReport } from "./status"

export interface RepublicDashboardOptions {
  directory?: string
  deliberationId?: string
  output?: string
  json?: boolean
  serve?: boolean
  open?: boolean
  port?: number
  refreshMs?: number
}

export interface RepublicDashboardNode {
  id: string
  label: string
  type:
    | "repository"
    | "deliberation"
    | "phase"
    | "chamber"
    | "workgroup"
    | "seat"
    | "agent"
    | "message"
    | "module"
    | "file"
    | "tool"
    | "task"
    | "decision"
  detail?: string
  status?: string
}

export interface RepublicDashboardEdge {
  id: string
  source: string
  target: string
  type: string
  label?: string
}

export interface RepublicDashboardData {
  generatedAt: string
  repository: NativeGitRepository | null
  deliberationID?: string
  report: RepublicStatusReport
  teamManifest: RepublicTeamManifest | null
  teamPhase: RepublicTeamPhaseState | null
  seatStates: RepublicSeatState[]
  ledgerRecords: RepublicLedgerRecord[]
  commonsMessages: RepublicCommonsMessage[]
  schedulerQueueRecords: RepublicSchedulerQueueRecord[]
  nativeGitRecords: NativeGitAuditRecord[]
  nodes: RepublicDashboardNode[]
  edges: RepublicDashboardEdge[]
}

function addNode(nodes: Map<string, RepublicDashboardNode>, node: RepublicDashboardNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node)
  }
}

function addEdge(edges: Map<string, RepublicDashboardEdge>, edge: RepublicDashboardEdge): void {
  if (edge.source === edge.target) return
  if (!edges.has(edge.id)) {
    edges.set(edge.id, edge)
  }
}

function basenameLike(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized
}

function moduleNameForFile(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/").filter(Boolean)
  if (parts.length <= 1) {
    return "(root)"
  }
  return parts[0]
}

function addWorkgroupNode(
  nodes: Map<string, RepublicDashboardNode>,
  edges: Map<string, RepublicDashboardEdge>,
  ownerID: string,
  workgroupID: string | undefined,
): string | undefined {
  if (!workgroupID) {
    return undefined
  }

  const nodeID = `workgroup:${workgroupID}`
  addNode(nodes, {
    id: nodeID,
    label: workgroupID,
    type: "workgroup",
    detail: `Workgroup ${workgroupID}`,
  })
  addEdge(edges, {
    id: `owner-workgroup:${ownerID}:${nodeID}`,
    source: ownerID,
    target: nodeID,
    type: "coordinates",
    label: "coordinates",
  })
  return nodeID
}

function addTaskNode(
  nodes: Map<string, RepublicDashboardNode>,
  edges: Map<string, RepublicDashboardEdge>,
  ownerID: string,
  taskID: string | undefined,
  status: string | undefined,
  dependsOn: string[] | undefined,
): string | undefined {
  if (!taskID) {
    return undefined
  }

  const nodeID = `task:${taskID}`
  addNode(nodes, {
    id: nodeID,
    label: taskID,
    type: "task",
    status,
    detail: status,
  })
  addEdge(edges, {
    id: `owner-task:${ownerID}:${nodeID}`,
    source: ownerID,
    target: nodeID,
    type: "owns",
    label: "owns",
  })

  for (const dependency of dependsOn ?? []) {
    const dependencyID = `task:${dependency}`
    addNode(nodes, {
      id: dependencyID,
      label: dependency,
      type: "task",
      detail: "Dependency task",
    })
    addEdge(edges, {
      id: `task-dependency:${nodeID}:${dependencyID}`,
      source: nodeID,
      target: dependencyID,
      type: "depends-on",
      label: "depends on",
    })
  }

  return nodeID
}

function addSupervisorEdge(
  nodes: Map<string, RepublicDashboardNode>,
  edges: Map<string, RepublicDashboardEdge>,
  supervisedID: string,
  supervisorSeatID: string | undefined,
): void {
  if (!supervisorSeatID) {
    return
  }

  const supervisorID = `seat:${supervisorSeatID}`
  addNode(nodes, {
    id: supervisorID,
    label: supervisorSeatID,
    type: "seat",
    detail: "Supervisor seat",
  })
  addEdge(edges, {
    id: `supervisor:${supervisorID}:${supervisedID}`,
    source: supervisorID,
    target: supervisedID,
    type: "supervises",
    label: "supervises",
  })
}

function resolveDeliberationIDs(
  report: RepublicStatusReport,
  ledgerRecords: RepublicLedgerRecord[],
  commonsMessages: RepublicCommonsMessage[],
): string[] {
  const ids = new Set<string>()
  for (const id of report.republic.deliberationIDs) {
    ids.add(sanitizeRepublicDeliberationID(id))
  }
  if (report.deliberationID) {
    ids.add(sanitizeRepublicDeliberationID(report.deliberationID))
  }
  for (const record of ledgerRecords) {
    ids.add(sanitizeRepublicDeliberationID(record.deliberationID))
  }
  for (const message of commonsMessages) {
    ids.add(sanitizeRepublicDeliberationID(message.deliberationID))
  }
  return Array.from(ids).sort()
}

function addFileNodes(
  nodes: Map<string, RepublicDashboardNode>,
  edges: Map<string, RepublicDashboardEdge>,
  sourceID: string,
  files: string[] | undefined,
  edgeType: string,
): void {
  for (const file of files ?? []) {
    const moduleName = moduleNameForFile(file)
    const moduleID = `module:${moduleName}`
    const fileID = `file:${file}`
    addNode(nodes, {
      id: moduleID,
      label: moduleName,
      type: "module",
      detail: `Module inferred from ${file}`,
    })
    addNode(nodes, {
      id: fileID,
      label: basenameLike(file),
      type: "file",
      detail: file,
    })
    addEdge(edges, {
      id: `module-file:${moduleID}:${fileID}`,
      source: moduleID,
      target: fileID,
      type: "contains",
      label: "contains",
    })
    addEdge(edges, {
      id: `${edgeType}:${sourceID}:${fileID}`,
      source: sourceID,
      target: fileID,
      type: edgeType,
      label: edgeType,
    })
  }
}

export function buildRepublicDashboardData(options: RepublicDashboardOptions = {}): RepublicDashboardData {
  const report = buildRepublicStatusReport(options)
  const repository = report.repository
  const ledgerRecords = repository ? readRepublicLedgerRecords(repository, options.deliberationId) : []
  const commonsMessages = repository ? readRepublicCommonsMessages(repository, options.deliberationId) : []
  const schedulerQueueRecords = repository ? readRepublicSchedulerQueueRecords(repository, options.deliberationId) : []
  const nativeGitRecords = repository ? readNativeGitAuditRecords(repository) : []
  const teamManifest = repository ? readRepublicTeamManifest(repository) : null
  const teamPhase = repository ? readRepublicTeamPhase(repository) : null
  const seatStates = repository && teamManifest
    ? teamManifest.seats
      .map((seat) => readRepublicSeatState(repository, seat.seatID))
      .filter((state): state is RepublicSeatState => state !== null)
    : []
  const nodes = new Map<string, RepublicDashboardNode>()
  const edges = new Map<string, RepublicDashboardEdge>()

  if (repository) {
    addNode(nodes, {
      id: "repository",
      label: basenameLike(repository.repoRoot),
      type: "repository",
      detail: repository.repoRoot,
    })

    const decisionID = `decision:${report.decision.status}`
    addNode(nodes, {
      id: decisionID,
      label: report.decision.status,
      type: "decision",
      status: report.decision.status,
      detail: report.decision.reason,
    })
    addEdge(edges, {
      id: `repository-decision:${decisionID}`,
      source: "repository",
      target: decisionID,
      type: "decision",
      label: "decision",
    })

    for (const deliberationID of resolveDeliberationIDs(report, ledgerRecords, commonsMessages)) {
      const deliberationNodeID = `deliberation:${deliberationID}`
      addNode(nodes, {
        id: deliberationNodeID,
        label: deliberationID,
        type: "deliberation",
        detail: `Deliberation ${deliberationID}`,
      })
      addEdge(edges, {
        id: `repository-deliberation:${deliberationID}`,
        source: "repository",
        target: deliberationNodeID,
        type: "deliberates",
        label: "deliberates",
      })
    }

    if (teamManifest) {
      const phaseID = teamPhase ? `phase:${teamPhase.phase}` : "phase:uninitialized"
      addNode(nodes, {
        id: phaseID,
        label: teamPhase?.phase ?? "team",
        type: "phase",
        status: teamPhase?.status,
        detail: teamPhase
          ? `Team phase ${teamPhase.phase}/${teamPhase.status}`
          : `Team model ${teamManifest.teamModel}`,
      })
      addEdge(edges, {
        id: `repository-team-phase:${phaseID}`,
        source: "repository",
        target: phaseID,
        type: "team-phase",
        label: "team phase",
      })

      for (const seat of teamManifest.seats) {
        const state = seatStates.find((candidate) => candidate.seatID === seat.seatID)
        const seatID = `seat:${seat.seatID}`
        addNode(nodes, {
          id: seatID,
          label: seat.seatID,
          type: "seat",
          status: state?.status,
          detail: [
            seat.role,
            state?.status ? `status=${state.status}` : undefined,
            seat.reason,
          ].filter(Boolean).join(" | "),
        })
        addEdge(edges, {
          id: `team-phase-seat:${phaseID}:${seatID}`,
          source: phaseID,
          target: seatID,
          type: "team-seat",
          label: "seat",
        })
        const workgroupID = addWorkgroupNode(nodes, edges, phaseID, seat.workgroupID)
        if (workgroupID) {
          addEdge(edges, {
            id: `team-workgroup-seat:${workgroupID}:${seatID}`,
            source: workgroupID,
            target: seatID,
            type: "assigns",
            label: "assigns",
          })
        }
        const taskNodeID = addTaskNode(nodes, edges, seatID, state?.taskID ?? seat.taskID, state?.status, state?.waitingOn)
        if (seat.module) {
          const moduleID = `module:${seat.module}`
          addNode(nodes, {
            id: moduleID,
            label: seat.module,
            type: "module",
            detail: `Team module ${seat.module}`,
          })
          addEdge(edges, {
            id: `team-seat-module:${seatID}:${moduleID}`,
            source: seatID,
            target: moduleID,
            type: "owns-module",
            label: "owns module",
          })
        }
        if (seat.runtimeAgent) {
          const agentID = `agent:${seat.runtimeAgent}`
          addNode(nodes, {
            id: agentID,
            label: seat.runtimeAgent,
            type: "agent",
            detail: seat.conceptualAgent,
          })
          addEdge(edges, {
            id: `team-agent-seat:${agentID}:${seatID}`,
            source: agentID,
            target: seatID,
            type: "runs",
            label: "runs",
          })
        }
        addSupervisorEdge(nodes, edges, taskNodeID ?? seatID, seat.role.includes("supervisor") ? undefined : "republic-supervisor")
      }
    }

    for (const record of ledgerRecords) {
      const deliberationID = sanitizeRepublicDeliberationID(record.deliberationID)
      const deliberationNodeID = `deliberation:${deliberationID}`
      const chamberID = record.chamber ? `chamber:${deliberationID}:${record.chamber}` : undefined
      const seatID = record.seatID ? `seat:${record.seatID}` : undefined

      if (record.chamber && chamberID) {
        addNode(nodes, {
          id: chamberID,
          label: record.chamber,
          type: "chamber",
          detail: `${record.chamber} chamber`,
        })
        addEdge(edges, {
          id: `deliberation-chamber:${deliberationNodeID}:${chamberID}`,
          source: deliberationNodeID,
          target: chamberID,
          type: "contains",
          label: "contains",
        })
      }

      if (record.seatID && seatID) {
        addNode(nodes, {
          id: seatID,
          label: record.seatID,
          type: "seat",
          status: record.vote,
          detail: record.summary,
        })
        addEdge(edges, {
          id: `seat-owner:${chamberID ?? deliberationNodeID}:${seatID}`,
          source: chamberID ?? deliberationNodeID,
          target: seatID,
          type: "seat",
          label: "seat",
        })
        if (record.agent) {
          const agentID = `agent:${record.agent}`
          addNode(nodes, {
            id: agentID,
            label: record.agent,
            type: "agent",
            detail: record.model,
          })
          addEdge(edges, {
            id: `agent-seat:${agentID}:${seatID}`,
            source: agentID,
            target: seatID,
            type: "runs",
            label: "runs",
          })
        }
        const workgroupID = addWorkgroupNode(nodes, edges, chamberID ?? deliberationNodeID, record.workgroupID)
        if (workgroupID) {
          addEdge(edges, {
            id: `workgroup-seat:${workgroupID}:${seatID}`,
            source: workgroupID,
            target: seatID,
            type: "assigns",
            label: "assigns",
          })
        }
        const taskNodeID = addTaskNode(nodes, edges, seatID, record.taskID, record.status, record.dependsOn)
        addSupervisorEdge(nodes, edges, seatID, record.supervisorSeatID)
        addFileNodes(nodes, edges, taskNodeID ?? seatID, record.files, "reviews")
        if (record.module) {
          const moduleID = `module:${record.module}`
          addNode(nodes, {
            id: moduleID,
            label: record.module,
            type: "module",
            detail: `Module ${record.module}`,
          })
          addEdge(edges, {
            id: `seat-module:${seatID}:${moduleID}`,
            source: seatID,
            target: moduleID,
            type: "owns-module",
            label: "owns module",
          })
        }
      }
    }

    for (const [index, message] of commonsMessages.entries()) {
      const messageID = message.messageID ?? `message-${index + 1}`
      const messageNodeID = `message:${messageID}`
      const authorSeatID = `seat:${message.authorSeatID}`
      addNode(nodes, {
        id: authorSeatID,
        label: message.authorSeatID,
        type: "seat",
        status: message.status,
        detail: message.authorRole,
      })
      addNode(nodes, {
        id: messageNodeID,
        label: message.messageType,
        type: "message",
        status: message.messageType,
        detail: message.content,
      })
      addEdge(edges, {
        id: `seat-message:${authorSeatID}:${messageNodeID}`,
        source: authorSeatID,
        target: messageNodeID,
        type: "published",
        label: "published",
      })

      if (message.authorAgent) {
        const agentID = `agent:${message.authorAgent}`
        addNode(nodes, {
          id: agentID,
          label: message.authorAgent,
          type: "agent",
        })
        addEdge(edges, {
          id: `agent-seat:${agentID}:${authorSeatID}`,
          source: agentID,
          target: authorSeatID,
          type: "runs",
          label: "runs",
        })
      }

      if (message.targetSeatID) {
        const targetSeatID = `seat:${message.targetSeatID}`
        addNode(nodes, {
          id: targetSeatID,
          label: message.targetSeatID,
          type: "seat",
        })
        addEdge(edges, {
          id: `message-target:${messageNodeID}:${targetSeatID}`,
          source: messageNodeID,
          target: targetSeatID,
          type: "targets",
          label: "targets",
        })
      }

      const workgroupID = addWorkgroupNode(
        nodes,
        edges,
        `deliberation:${sanitizeRepublicDeliberationID(message.deliberationID)}`,
        message.workgroupID,
      )
      if (workgroupID) {
        addEdge(edges, {
          id: `workgroup-message:${workgroupID}:${messageNodeID}`,
          source: workgroupID,
          target: messageNodeID,
          type: "contains",
          label: "contains",
        })
      }
      const taskNodeID = addTaskNode(nodes, edges, messageNodeID, message.taskID, message.status, message.dependsOn)
      addSupervisorEdge(nodes, edges, authorSeatID, message.supervisorSeatID)
      if (message.module) {
        const moduleID = `module:${message.module}`
        addNode(nodes, {
          id: moduleID,
          label: message.module,
          type: "module",
          detail: `Module ${message.module}`,
        })
        addEdge(edges, {
          id: `message-module:${messageNodeID}:${moduleID}`,
          source: messageNodeID,
          target: moduleID,
          type: "discusses-module",
          label: "discusses module",
        })
      }

      for (const reference of message.references ?? []) {
        addNode(nodes, {
          id: `message:${reference}`,
          label: reference,
          type: "message",
          detail: "Referenced commons message",
        })
        addEdge(edges, {
          id: `message-reference:${messageNodeID}:${reference}`,
          source: messageNodeID,
          target: `message:${reference}`,
          type: "references",
          label: "references",
        })
      }

      addFileNodes(nodes, edges, taskNodeID ?? messageNodeID, message.files, "discusses")
    }

    for (const [index, record] of nativeGitRecords.entries()) {
      const toolID = `tool:${record.tool}:${index + 1}`
      addNode(nodes, {
        id: toolID,
        label: record.tool,
        type: "tool",
        detail: record.summary,
      })
      addEdge(edges, {
        id: `repository-tool:${toolID}`,
        source: "repository",
        target: toolID,
        type: "changed-by",
        label: "changed by",
      })
      if (record.agent) {
        const agentID = `agent:${record.agent}`
        addNode(nodes, {
          id: agentID,
          label: record.agent,
          type: "agent",
          detail: record.model,
        })
        addEdge(edges, {
          id: `agent-tool:${agentID}:${toolID}`,
          source: agentID,
          target: toolID,
          type: "used",
          label: "used",
        })
      }
      addFileNodes(nodes, edges, toolID, record.files, "changed")
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    repository,
    deliberationID: options.deliberationId,
    report,
    teamManifest,
    teamPhase,
    seatStates,
    ledgerRecords,
    commonsMessages,
    schedulerQueueRecords,
    nativeGitRecords,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  }
}

function defaultDashboardPath(repository: NativeGitRepository, output?: string): string {
  return output ? resolve(output) : join(repository.gitCommonDir, "omo", "republic", "dashboard.html")
}

export interface DashboardOpenCommand {
  command: string
  args: string[]
}

export function getDashboardOpenCommand(target: string, platform: string = process.platform): DashboardOpenCommand | null {
  if (platform === "win32") {
    return { command: "cmd.exe", args: ["/c", "start", "", target] }
  }
  if (platform === "darwin") {
    return { command: "open", args: [target] }
  }
  if (["linux", "freebsd", "openbsd"].includes(platform)) {
    return { command: "xdg-open", args: [target] }
  }
  return null
}

export function openDashboardTarget(target: string, platform: string = process.platform): boolean {
  const command = getDashboardOpenCommand(target, platform)
  if (!command) {
    return false
  }

  try {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

function escapeJsonForScript(data: RepublicDashboardData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c")
}

export function renderRepublicDashboardHtml(data: RepublicDashboardData, options: { live?: boolean; refreshMs?: number } = {}): string {
  const initialData = escapeJsonForScript(data)
  const refreshMs = options.refreshMs ?? 2000
  const liveLoader = options.live
    ? `async function loadData(){ try { const response = await fetch("/data.json", { cache: "no-store", headers: { "cache-control": "no-cache" } }); const next = await response.json(); if (!next.repository && currentData?.repository) return currentData; if (!next.repository && initialDashboardData?.repository) return initialDashboardData; return next; } catch { return currentData ?? initialDashboardData; } }`
    : `async function loadData(){ return initialDashboardData; }`

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OMO Republic Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#0b0d10; --header:#05070a; --panel:#151922; --panel2:#10141b; --surface:#1b212b; --line:#303842; --soft-line:#242b35; --text:#edf2f7; --muted:#9aa7b5; --accent:#4f8cff; --green:#42c27a; --red:#ff6868; --yellow:#e1b84d; --purple:#b08cff; --cyan:#4cc9d8; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    header { height:60px; display:flex; align-items:center; justify-content:space-between; gap:18px; padding:0 22px; border-bottom:1px solid var(--line); background:var(--header); }
    main.dashboard-shell { display:grid; grid-template-columns:minmax(260px,320px) minmax(560px,1fr) minmax(360px,440px); height:calc(100vh - 60px); min-height:720px; }
    aside { background:var(--panel); overflow:auto; }
    .summary-panel { border-right:1px solid var(--line); }
    .inspector-panel { border-left:1px solid var(--line); }
    .workspace { overflow:auto; padding:20px; background:linear-gradient(180deg, #0f1319 0%, #0b0d10 100%); }
    .pad { padding:18px 20px; }
    h1 { margin:0; font-size:18px; letter-spacing:0; }
    h2 { margin:0; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0; }
    h3 { margin:0 0 10px; font-size:14px; }
    p { margin:0; }
    .section-heading { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
    .section-heading p { color:var(--muted); font-size:12px; }
    .workspace-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px; }
    .workspace-header h2 { color:var(--text); font-size:16px; text-transform:none; }
    .workspace-header p { color:var(--muted); margin-top:4px; }
    .header-pills, #board-pills { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
    .language-select { height:28px; border:1px solid var(--line); border-radius:999px; padding:0 10px; color:var(--text); background:#0d1117; }
    .metric { display:flex; justify-content:space-between; gap:16px; padding:8px 0; border-bottom:1px solid rgba(48,56,66,.72); }
    .metric-button { width:100%; color:inherit; background:transparent; border:0; cursor:pointer; font:inherit; }
    .metric-button:hover { color:var(--text); }
    .metric span:first-child { color:var(--muted); }
    .metric strong { text-align:right; overflow-wrap:anywhere; }
    .metric-group { border:1px solid var(--soft-line); border-radius:8px; padding:12px; background:var(--panel2); margin-bottom:12px; }
    .metric-group h3 { color:var(--text); font-size:13px; margin-bottom:6px; }
    .metric-group .metric:last-child { border-bottom:0; padding-bottom:0; }
    .decision-card { border:1px solid rgba(79,140,255,.42); border-radius:8px; padding:12px; background:#111827; margin-bottom:12px; }
    .decision-card strong { display:block; font-size:20px; margin:4px 0; overflow-wrap:anywhere; }
    .decision-card p { color:var(--muted); font-size:12px; }
    .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:3px 9px; color:var(--muted); font-size:12px; white-space:nowrap; }
    .pill.good { color:var(--green); border-color:rgba(66,194,122,.45); }
    .pill.warn { color:var(--yellow); border-color:rgba(225,184,77,.45); }
    .pill.bad { color:var(--red); border-color:rgba(255,104,104,.45); }
    .board { min-width:0; display:flex; flex-direction:column; gap:16px; }
    .phase-strip { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; }
    .phase-card { border:1px solid var(--line); border-radius:8px; padding:11px; background:var(--panel2); min-height:86px; color:var(--text); text-align:left; cursor:pointer; font:inherit; }
    .phase-card.active, .phase-card.selected { border-color:var(--accent); box-shadow:0 0 0 1px rgba(79,140,255,.22) inset; }
    .phase-card:hover { background:#131a24; }
    .phase-title { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:9px; }
    .phase-title strong { font-size:13px; text-transform:uppercase; }
    .phase-title span { color:var(--muted); font-size:12px; }
    .phase-meter { height:4px; border-radius:999px; background:#232b36; overflow:hidden; margin-top:10px; }
    .phase-meter div { height:100%; background:var(--accent); }
    .board-section { border:1px solid var(--soft-line); border-radius:8px; background:rgba(16,20,27,.82); overflow:hidden; }
    .board-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 14px; border-bottom:1px solid var(--soft-line); background:#151b24; }
    .board-section-head strong { font-size:14px; }
    .supervisor-zone { border-color:rgba(176,140,255,.42); }
    .workgroup-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; padding:12px; }
    .workgroup-card { border:1px solid var(--line); border-radius:8px; background:#10151d; overflow:hidden; }
    .workgroup-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:12px; border-bottom:1px solid var(--soft-line); background:#121923; }
    .workgroup-head strong { display:block; font-size:14px; overflow-wrap:anywhere; }
    .workgroup-head small { display:block; color:var(--muted); margin-top:3px; }
    .workgroup-stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; padding:10px 12px 0; }
    .stat-chip { border:1px solid var(--soft-line); border-radius:8px; padding:7px; background:#0c1016; }
    .stat-chip span { display:block; color:var(--muted); font-size:11px; }
    .stat-chip strong { font-size:15px; }
    .seat-orbit { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px; padding:12px; }
    .seat-list { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px; padding:12px; }
    .seat-card { width:100%; text-align:left; border:1px solid var(--line); border-radius:8px; padding:10px; background:#0d1117; color:var(--text); cursor:pointer; transition:border-color .12s ease, background .12s ease; min-height:112px; display:flex; flex-direction:column; justify-content:space-between; }
    .seat-card:hover, .seat-card.selected { border-color:var(--accent); background:#111a27; }
    .seat-top { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:5px; }
    .seat-name { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .seat-meta { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .seat-foot { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .communication-section { overflow:hidden; }
    .communication-map { position:relative; min-height:280px; padding:14px; background:radial-gradient(circle at 50% 40%, rgba(79,140,255,.08), transparent 52%); }
    .communication-empty { position:relative; z-index:2; }
    .comm-lanes { position:relative; z-index:2; display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; }
    .comm-lane { border:1px solid rgba(48,56,66,.78); border-radius:8px; background:rgba(12,16,22,.88); padding:10px; min-height:188px; }
    .comm-lane h4 { margin:0 0 8px; font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0; display:flex; justify-content:space-between; gap:8px; }
    .comm-node-stack { display:flex; flex-direction:column; gap:8px; }
    .comm-seat-node { position:relative; width:100%; border:1px solid var(--line); border-radius:8px; padding:8px 9px; background:#0d1117; color:var(--text); text-align:left; cursor:pointer; font:inherit; transition:border-color .12s ease, background .12s ease; }
    .comm-seat-node:hover, .comm-seat-node.selected { border-color:var(--accent); background:#111a27; }
    .comm-seat-node strong { display:block; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .comm-seat-node small { display:block; color:var(--muted); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .comm-node-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .comm-dot { display:inline-block; width:8px; height:8px; border-radius:999px; background:var(--muted); flex:0 0 auto; }
    .comm-dot.planning { background:var(--accent); }
    .comm-dot.execution { background:var(--cyan); }
    .comm-dot.review { background:var(--green); }
    .comm-dot.idle { background:var(--purple); }
    .comm-edge-svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:auto; z-index:1; overflow:visible; }
    .comm-edge { fill:none; color:var(--accent); stroke:var(--accent); stroke-width:2; opacity:.74; pointer-events:stroke; cursor:pointer; transition:opacity .12s ease, stroke-width .12s ease; }
    .comm-edge:hover, .comm-edge.selected { opacity:1; stroke-width:4; }
    .comm-edge.question { color:var(--yellow); stroke:var(--yellow); }
    .comm-edge.answer, .comm-edge.consensus, .comm-edge.contract { color:var(--green); stroke:var(--green); }
    .comm-edge.objection, .comm-edge.dependency-blocked, .comm-edge.error { color:var(--red); stroke:var(--red); }
    .comm-edge.intervention, .comm-edge.supervisor-policy { color:var(--purple); stroke:var(--purple); }
    .comm-edge.status, .comm-edge.proposal, .comm-edge.revision, .comm-edge.handoff { color:var(--accent); stroke:var(--accent); }
    .comm-legend { display:flex; flex-wrap:wrap; gap:8px; padding:0 14px 14px; color:var(--muted); font-size:11px; }
    .comm-legend span { display:inline-flex; align-items:center; gap:5px; }
    .comm-legend i { width:10px; height:2px; border-radius:999px; display:inline-block; background:var(--accent); }
    .comm-legend .question i { background:var(--yellow); }
    .comm-legend .answer i { background:var(--green); }
    .comm-legend .objection i { background:var(--red); }
    .comm-legend .intervention i { background:var(--purple); }
    .relation-summary { border:1px solid rgba(79,140,255,.42); border-radius:8px; padding:12px; background:#111827; }
    .relation-pair { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-weight:700; margin-bottom:8px; }
    .relation-arrow { color:var(--accent); }
    .status { display:inline-flex; align-items:center; border-radius:999px; padding:2px 8px; font-size:11px; border:1px solid var(--line); color:var(--muted); white-space:nowrap; }
    .status-running { color:var(--cyan); border-color:rgba(76,201,216,.45); }
    .status-waiting { color:var(--yellow); border-color:rgba(225,184,77,.45); }
    .status-blocked, .status-error { color:var(--red); border-color:rgba(255,104,104,.45); }
    .status-done { color:var(--green); border-color:rgba(66,194,122,.45); }
    .status-standby { color:var(--muted); }
    .timeline-panel { margin-top:18px; border:1px solid var(--soft-line); border-radius:8px; background:var(--panel2); padding:14px; }
    .timeline, .inspector-list { display:flex; flex-direction:column; gap:10px; }
    .timeline { max-height:520px; overflow:auto; padding-right:4px; }
    .item { border:1px solid var(--soft-line); border-radius:8px; padding:10px; background:#0d1117; }
    .timeline-event { border-left:3px solid var(--accent); }
    .timeline-event.question { border-left-color:var(--yellow); }
    .timeline-event.answer, .timeline-event.consensus, .timeline-event.contract { border-left-color:var(--green); }
    .timeline-event.intervention, .timeline-event.supervisor-policy { border-left-color:var(--purple); }
    .timeline-event.dependency-blocked { border-left-color:var(--red); }
    .item strong { display:block; margin-bottom:4px; overflow-wrap:anywhere; }
    .item p { margin:0; color:var(--muted); overflow-wrap:anywhere; }
    .item small { color:var(--muted); overflow-wrap:anywhere; }
    .inspector { display:flex; flex-direction:column; gap:16px; }
    .inspector-title { border:1px solid var(--line); border-radius:8px; padding:12px; background:#0d1117; }
    .inspector-title strong { display:block; font-size:16px; margin-bottom:6px; overflow-wrap:anywhere; }
    .progress { height:8px; border-radius:999px; overflow:hidden; background:#232b36; }
    .progress div { height:100%; background:var(--green); width:0; }
    .detail-block { border:1px solid var(--soft-line); border-radius:8px; background:#0d1117; overflow:hidden; }
    details.detail-block summary { cursor:pointer; list-style:none; padding:10px 12px; color:var(--text); font-weight:700; border-bottom:1px solid var(--soft-line); display:flex; align-items:center; justify-content:space-between; gap:12px; }
    details.detail-block summary .summary-text { min-width:0; overflow-wrap:anywhere; }
    details.detail-block summary .summary-action { color:var(--muted); font-weight:400; font-size:11px; text-transform:uppercase; flex:0 0 auto; }
    details.detail-block summary::-webkit-details-marker { display:none; }
    .detail-body { padding:10px 12px; color:var(--muted); overflow-wrap:anywhere; }
    .detail-body p { margin-bottom:8px; }
    .raw-json { margin:0; max-height:320px; overflow:auto; white-space:pre-wrap; color:#cbd5e1; font:12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .item-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .summary-line { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .empty { border:1px dashed var(--line); border-radius:8px; padding:14px; color:var(--muted); background:#0d1117; }
    .phase-hidden { display:none; }
    .muted { color:var(--muted); }
    .status-approved { color:var(--green); }
    .status-blocked { color:var(--red); }
    .status-needs-quorum, .status-revise { color:var(--yellow); }
    @media (max-width: 1200px) { main.dashboard-shell { grid-template-columns:1fr; height:auto; min-height:0; } .summary-panel, .inspector-panel { border:0; border-bottom:1px solid var(--line); } .workspace { min-height:640px; } .phase-strip { grid-template-columns:repeat(2, minmax(140px, 1fr)); } }
  </style>
</head>
<body>
  <script type="application/json" id="republic-data">${initialData}</script>
  <header>
    <h1 data-i18n="title">OMO Republic Dashboard</h1>
    <div class="header-pills"><select id="lang-select" class="language-select" aria-label="Language"><option value="en">English</option><option value="zh">中文</option><option value="ja">日本語</option><option value="ko">한국어</option></select><span id="repo-pill" class="pill"></span><span id="refresh-pill" class="pill"></span></div>
  </header>
  <main class="dashboard-shell">
    <aside class="summary-panel pad">
      <div class="section-heading"><h2 data-i18n="governance">Governance Snapshot</h2><p data-i18n="governanceDesc">Decision, dispatch pressure, and traceability health.</p></div>
      <div id="metrics"></div>
    </aside>
    <section class="workspace">
      <div class="workspace-header">
        <div>
          <h2 data-i18n="commandBoard">Command Board</h2>
          <p id="board-subtitle"></p>
        </div>
        <div id="board-pills"></div>
      </div>
      <div id="team-board" class="board" aria-label="OMO Republic team board"></div>
      <section class="timeline-panel" aria-label="Commons timeline">
        <div class="section-heading"><h2 data-i18n="commonsTimeline">Commons Timeline</h2><p data-i18n="commonsDesc">Recent proposals, questions, answers, objections, contracts, and supervisor notes.</p></div>
        <div id="timeline" class="timeline"></div>
      </section>
    </section>
    <aside class="inspector-panel pad right">
      <div id="seat-inspector" class="inspector"></div>
    </aside>
  </main>
  <script>
    const colors = { approved:"status-approved", blocked:"status-blocked", "needs-quorum":"status-needs-quorum", revise:"status-revise" };
    const initialDashboardData = JSON.parse(document.getElementById("republic-data").textContent);
    let currentData = null;
    let selectedSeatID = null;
    let selectedPhase = "all";
    let selectedMetric = null;
    let selectedRelationKey = null;
    const openDetails = new Set();
    const i18n = {
      en: {
        title:"OMO Republic Dashboard", governance:"Governance Snapshot", governanceDesc:"Decision, dispatch pressure, and traceability health.", commandBoard:"Command Board", commonsTimeline:"Commons Timeline", commonsDesc:"Recent proposals, questions, answers, objections, contracts, and supervisor notes.", decision:"Decision", team:"Team", runtime:"Runtime Mapping", seatState:"Seat State", records:"Records", governanceGroup:"Governance", model:"Model", allocation:"Allocation", phase:"Phase", workgroups:"Workgroups", seats:"Seats", all:"All", defaultRuntime:"Default runtime agent", maxParallel:"Max parallel seats", planningSeats:"Planning seats", executionSeats:"Execution seats", reviewSeats:"Review seats", running:"Running", waiting:"Waiting", blocked:"Blocked", done:"Done", standby:"Standby", commons:"Commons", targeted:"Targeted", referenced:"Referenced", nativeGit:"Native git", pendingDispatches:"Pending dispatches", queuedRecords:"Queued records", dispatchedTasks:"Dispatched tasks", contracts:"Contracts", contractWarnings:"Contract warnings", supervisorLane:"Supervisor Lane", teamLoad:"Team Load", workgroupLabel:"Workgroups", noTeam:"No persistent Republic team has been initialized yet.", noTimeline:"No commons messages yet.", awaitingClosure:"No seat or scheduler work is active. The team phase is still open, so publish a final review/phase update or inspect warnings before treating this run as complete.", idleClosure:"idle, awaiting closure", seatInspector:"Seat Inspector", clickSeat:"Click a seat to inspect status, inbox, and interaction completion.", seatDefinition:"Seat Definition", currentState:"Current State", interactionCompletion:"Interaction Completion", schedulerQueue:"Scheduler Queue", contractTraceability:"Contract Traceability", recentInteractions:"Recent Seat Interactions", noQueue:"No queued or dispatched scheduler work for this seat.", noContract:"No contract linked to this seat yet.", noInteractions:"No direct interactions for this seat yet.", waitingOn:"Waiting on", task:"Task", runtimeAgent:"Runtime agent", conceptualAgent:"Conceptual agent", module:"Module", noMetric:"Click a left metric group to inspect raw supporting data."
      },
      zh: {
        title:"OMO Republic 指挥面板", governance:"治理快照", governanceDesc:"决策、调度压力与可追踪健康度。", commandBoard:"指挥台", commonsTimeline:"Commons 时间线", commonsDesc:"最近的提案、问题、回答、异议、契约和监督记录。", decision:"决策", team:"团队", runtime:"运行映射", seatState:"席位状态", records:"记录", governanceGroup:"治理", model:"模式", allocation:"分配", phase:"阶段", workgroups:"工作组", seats:"席位", all:"全部", defaultRuntime:"默认运行代理", maxParallel:"最大并行席位", planningSeats:"规划席位", executionSeats:"执行席位", reviewSeats:"审查席位", running:"运行中", waiting:"等待中", blocked:"阻塞", done:"完成", standby:"待命", commons:"Commons", targeted:"定向消息", referenced:"引用消息", nativeGit:"原生 Git", pendingDispatches:"待派发", queuedRecords:"队列记录", dispatchedTasks:"已派发任务", contracts:"契约", contractWarnings:"契约警告", supervisorLane:"监督席位", teamLoad:"团队负载", workgroupLabel:"工作组", noTeam:"还没有初始化持久 Republic 团队。", noTimeline:"还没有 Commons 消息。", awaitingClosure:"当前没有 seat 或 scheduler 在运行。团队阶段仍处于打开状态，需要发布最终审查/阶段更新，或先检查警告再判定完成。", idleClosure:"空闲，等待收口", seatInspector:"席位检查器", clickSeat:"点击一个席位查看状态、收件箱和交互完成情况。", seatDefinition:"席位定义", currentState:"当前状态", interactionCompletion:"交互完成度", schedulerQueue:"调度队列", contractTraceability:"契约追踪", recentInteractions:"最近席位交互", noQueue:"这个席位没有排队或已派发的调度工作。", noContract:"这个席位还没有关联契约。", noInteractions:"这个席位还没有直接交互。", waitingOn:"等待对象", task:"任务", runtimeAgent:"运行代理", conceptualAgent:"概念代理", module:"模块", noMetric:"点击左侧指标组查看原始支撑数据。"
      },
      ja: {
        title:"OMO Republic ダッシュボード", governance:"ガバナンス概要", governanceDesc:"意思決定、ディスパッチ負荷、追跡性の健全性。", commandBoard:"コマンドボード", commonsTimeline:"Commons タイムライン", commonsDesc:"最近の提案、質問、回答、異議、契約、監督メモ。", decision:"判断", team:"チーム", runtime:"ランタイム対応", seatState:"シート状態", records:"記録", governanceGroup:"ガバナンス", model:"モデル", allocation:"割当", phase:"フェーズ", workgroups:"作業グループ", seats:"シート", all:"すべて", defaultRuntime:"既定ランタイム代理", maxParallel:"最大並列シート", planningSeats:"計画シート", executionSeats:"実行シート", reviewSeats:"レビューシート", running:"実行中", waiting:"待機中", blocked:"ブロック", done:"完了", standby:"待機", commons:"Commons", targeted:"宛先付き", referenced:"参照済み", nativeGit:"Native Git", pendingDispatches:"未処理ディスパッチ", queuedRecords:"キュー記録", dispatchedTasks:"派遣済みタスク", contracts:"契約", contractWarnings:"契約警告", supervisorLane:"監督レーン", teamLoad:"チーム負荷", workgroupLabel:"作業グループ", noTeam:"永続 Republic チームはまだ初期化されていません。", noTimeline:"Commons メッセージはまだありません。", awaitingClosure:"実行中の seat / scheduler はありません。フェーズはまだ開いているため、完了扱いの前に最終レビュー/フェーズ更新または警告確認が必要です。", idleClosure:"アイドル、終了待ち", seatInspector:"シート検査", clickSeat:"シートをクリックして状態、受信箱、対話完了度を確認します。", seatDefinition:"シート定義", currentState:"現在状態", interactionCompletion:"対話完了度", schedulerQueue:"スケジューラキュー", contractTraceability:"契約追跡", recentInteractions:"最近のシート対話", noQueue:"このシートにキューまたは派遣済み作業はありません。", noContract:"このシートに紐づく契約はまだありません。", noInteractions:"このシートに直接対話はまだありません。", waitingOn:"待機対象", task:"タスク", runtimeAgent:"ランタイム代理", conceptualAgent:"概念代理", module:"モジュール", noMetric:"左側の指標グループをクリックすると根拠データを確認できます。"
      },
      ko: {
        title:"OMO Republic 대시보드", governance:"거버넌스 스냅샷", governanceDesc:"의사결정, 디스패치 압력, 추적성 상태.", commandBoard:"커맨드 보드", commonsTimeline:"Commons 타임라인", commonsDesc:"최근 제안, 질문, 답변, 이의, 계약, 감독 기록.", decision:"결정", team:"팀", runtime:"런타임 매핑", seatState:"시트 상태", records:"기록", governanceGroup:"거버넌스", model:"모델", allocation:"할당", phase:"단계", workgroups:"작업그룹", seats:"시트", all:"전체", defaultRuntime:"기본 런타임 에이전트", maxParallel:"최대 병렬 시트", planningSeats:"계획 시트", executionSeats:"실행 시트", reviewSeats:"리뷰 시트", running:"실행 중", waiting:"대기 중", blocked:"차단", done:"완료", standby:"대기", commons:"Commons", targeted:"지정 메시지", referenced:"참조 메시지", nativeGit:"Native Git", pendingDispatches:"대기 디스패치", queuedRecords:"큐 기록", dispatchedTasks:"디스패치된 작업", contracts:"계약", contractWarnings:"계약 경고", supervisorLane:"감독 레인", teamLoad:"팀 부하", workgroupLabel:"작업그룹", noTeam:"지속 Republic 팀이 아직 초기화되지 않았습니다.", noTimeline:"Commons 메시지가 아직 없습니다.", awaitingClosure:"활성 seat 또는 scheduler 작업이 없습니다. 팀 단계가 아직 열려 있으므로 완료 처리 전에 최종 리뷰/단계 업데이트 또는 경고 확인이 필요합니다.", idleClosure:"유휴, 종료 대기", seatInspector:"시트 검사기", clickSeat:"시트를 클릭해 상태, 받은 메시지, 상호작용 완료도를 확인하세요.", seatDefinition:"시트 정의", currentState:"현재 상태", interactionCompletion:"상호작용 완료도", schedulerQueue:"스케줄러 큐", contractTraceability:"계약 추적", recentInteractions:"최근 시트 상호작용", noQueue:"이 시트에는 큐 또는 디스패치된 작업이 없습니다.", noContract:"이 시트와 연결된 계약이 아직 없습니다.", noInteractions:"이 시트에는 직접 상호작용이 아직 없습니다.", waitingOn:"대기 대상", task:"작업", runtimeAgent:"런타임 에이전트", conceptualAgent:"개념 에이전트", module:"모듈", noMetric:"왼쪽 지표 그룹을 클릭하면 근거 데이터를 볼 수 있습니다."
      },
    };
    let lang = localStorage.getItem("omo-republic-lang") || "en";
    function t(key) { return (i18n[lang] && i18n[lang][key]) || i18n.en[key] || key; }
    const runtimeLabels = {
      en: {
        updated:"Updated", noGitRepository:"No git repository", none:"none", notAvailable:"n/a", noTeamShort:"no team", pending:"pending", queue:"queue", threads:"threads", messages:"msgs", assigned:"assigned", groups:"groups", active:"active", rawData:"Raw Data", channel:"channel", round:"round", status:"status", references:"refs", files:"files", target:"target", requested:"requested", dispatch:"dispatch", questionThreadsCompleted:"question threads completed", authoredQuestions:"Authored questions", inboundQuestions:"Inbound questions", noAllocationReason:"No allocation reason recorded.", noLiveStateMemory:"No live state memory recorded.", allTermsCovered:"All extracted hard terms are covered.", uncoveredTerms:"Uncovered terms", expand:"expand", collapse:"collapse", planning:"planning", execution:"execution", review:"review", idle:"idle", inProgress:"in progress", needsQuorum:"needs quorum", noRecords:"no records", approved:"approved", approve:"approve", revise:"revise", rejected:"rejected", reject:"reject", running:"running", waiting:"waiting", blocked:"blocked", done:"done", standby:"standby", error:"error", proposal:"proposal", question:"question", answer:"answer", objection:"objection", revision:"revision", handoff:"handoff", contract:"contract", consensus:"consensus", supervisorPolicy:"supervisor policy", intervention:"intervention", dependencyBlocked:"dependency blocked", nativeGitChange:"native git change"
      },
      zh: {
        updated:"更新于", noGitRepository:"无 Git 仓库", none:"无", notAvailable:"不可用", noTeamShort:"无团队", pending:"待处理", queue:"队列", threads:"线程", messages:"消息", assigned:"已分配", groups:"组", active:"活跃", rawData:"原始数据", channel:"频道", round:"轮次", status:"状态", references:"引用", files:"文件", target:"目标", requested:"请求代理", dispatch:"派发", questionThreadsCompleted:"问题线程已完成", authoredQuestions:"发起问题", inboundQuestions:"收到问题", noAllocationReason:"没有记录分配原因。", noLiveStateMemory:"没有记录实时状态记忆。", allTermsCovered:"所有抽取的硬性条款都已覆盖。", uncoveredTerms:"未覆盖条款", expand:"展开", collapse:"收起", planning:"规划", execution:"执行", review:"审查", idle:"空闲", inProgress:"进行中", needsQuorum:"未达法定人数", noRecords:"无记录", approved:"已批准", approve:"批准", revise:"需修订", rejected:"已拒绝", reject:"拒绝", running:"运行中", waiting:"等待中", blocked:"阻塞", done:"完成", standby:"待命", error:"错误", proposal:"提案", question:"问题", answer:"回答", objection:"异议", revision:"修订", handoff:"交接", contract:"契约", consensus:"共识", supervisorPolicy:"监督策略", intervention:"干预", dependencyBlocked:"依赖阻塞", nativeGitChange:"原生 Git 变更"
      },
      ja: {
        updated:"更新", noGitRepository:"Git リポジトリなし", none:"なし", notAvailable:"該当なし", noTeamShort:"チームなし", pending:"保留", queue:"キュー", threads:"スレッド", messages:"メッセージ", assigned:"割当済み", groups:"グループ", active:"アクティブ", rawData:"生データ", channel:"チャンネル", round:"ラウンド", status:"状態", references:"参照", files:"ファイル", target:"対象", requested:"要求代理", dispatch:"派遣", questionThreadsCompleted:"質問スレッド完了", authoredQuestions:"作成した質問", inboundQuestions:"受信質問", noAllocationReason:"割当理由は記録されていません。", noLiveStateMemory:"現在状態メモリは記録されていません。", allTermsCovered:"抽出された必須条件はすべてカバー済みです。", uncoveredTerms:"未カバー条件", expand:"展開", collapse:"折りたたむ", planning:"計画", execution:"実行", review:"レビュー", idle:"アイドル", inProgress:"進行中", needsQuorum:"定足数不足", noRecords:"記録なし", approved:"承認済み", approve:"承認", revise:"修正必要", rejected:"却下済み", reject:"却下", running:"実行中", waiting:"待機中", blocked:"ブロック", done:"完了", standby:"待機", error:"エラー", proposal:"提案", question:"質問", answer:"回答", objection:"異議", revision:"修正", handoff:"引き継ぎ", contract:"契約", consensus:"合意", supervisorPolicy:"監督方針", intervention:"介入", dependencyBlocked:"依存関係ブロック", nativeGitChange:"Native Git 変更"
      },
      ko: {
        updated:"업데이트", noGitRepository:"Git 저장소 없음", none:"없음", notAvailable:"해당 없음", noTeamShort:"팀 없음", pending:"대기", queue:"큐", threads:"스레드", messages:"메시지", assigned:"할당됨", groups:"그룹", active:"활성", rawData:"원본 데이터", channel:"채널", round:"라운드", status:"상태", references:"참조", files:"파일", target:"대상", requested:"요청 에이전트", dispatch:"디스패치", questionThreadsCompleted:"질문 스레드 완료", authoredQuestions:"작성한 질문", inboundQuestions:"받은 질문", noAllocationReason:"할당 이유가 기록되지 않았습니다.", noLiveStateMemory:"실시간 상태 메모리가 기록되지 않았습니다.", allTermsCovered:"추출된 필수 조건이 모두 충족되었습니다.", uncoveredTerms:"미충족 조건", expand:"펼치기", collapse:"접기", planning:"계획", execution:"실행", review:"리뷰", idle:"유휴", inProgress:"진행 중", needsQuorum:"정족수 부족", noRecords:"기록 없음", approved:"승인됨", approve:"승인", revise:"수정 필요", rejected:"거부됨", reject:"거부", running:"실행 중", waiting:"대기 중", blocked:"차단", done:"완료", standby:"대기", error:"오류", proposal:"제안", question:"질문", answer:"답변", objection:"이의", revision:"수정", handoff:"인계", contract:"계약", consensus:"합의", supervisorPolicy:"감독 정책", intervention:"개입", dependencyBlocked:"의존성 차단", nativeGitChange:"Native Git 변경"
      },
    };
    const dashboardExtraI18n = {
      en: {
        communicationMap:"Seat Communication Map",
        communicationDesc:"Directed seat-to-seat communication. Click a line to inspect that pair's messages.",
        noRelations:"No directed seat communication has been recorded yet.",
        selectedRelation:"Selected Relationship",
        from:"From",
        to:"To",
        messageTypes:"Message Types",
        latestMessage:"Latest Message",
        relationMessages:"Relationship Messages",
        relationInspectorHint:"Click a communication line to inspect the conversation between two seats.",
      },
      zh: {
        communicationMap:"席位通信图",
        communicationDesc:"按席位之间的定向交流聚合。点击连线可查看这两个席位的消息。",
        noRelations:"还没有记录到席位之间的定向交流。",
        selectedRelation:"选中的通信关系",
        from:"来自",
        to:"发往",
        messageTypes:"消息类型",
        latestMessage:"最新消息",
        relationMessages:"关系消息",
        relationInspectorHint:"点击通信连线，查看两个席位之间的对话。",
      },
      ja: {
        communicationMap:"シート通信図",
        communicationDesc:"シート間の有向コミュニケーションを集約します。線をクリックすると、その2席のメッセージを確認できます。",
        noRelations:"シート間の有向コミュニケーションはまだ記録されていません。",
        selectedRelation:"選択中の通信関係",
        from:"送信元",
        to:"送信先",
        messageTypes:"メッセージ種別",
        latestMessage:"最新メッセージ",
        relationMessages:"関係メッセージ",
        relationInspectorHint:"通信線をクリックすると、2つのシート間の会話を確認できます。",
      },
      ko: {
        communicationMap:"시트 통신 지도",
        communicationDesc:"시트 간 방향성 있는 소통을 집계합니다. 선을 클릭하면 두 시트의 메시지를 확인할 수 있습니다.",
        noRelations:"아직 시트 간 방향성 있는 소통 기록이 없습니다.",
        selectedRelation:"선택한 통신 관계",
        from:"보낸 시트",
        to:"받는 시트",
        messageTypes:"메시지 유형",
        latestMessage:"최근 메시지",
        relationMessages:"관계 메시지",
        relationInspectorHint:"통신선을 클릭하면 두 시트 사이의 대화를 확인할 수 있습니다.",
      },
    };
    for (const [locale, values] of Object.entries(dashboardExtraI18n)) {
      Object.assign(i18n[locale] ?? (i18n[locale] = {}), values);
    }
    const enumKeyMap = {
      "in-progress":"inProgress", "needs-quorum":"needsQuorum", "no-records":"noRecords", "supervisor-policy":"supervisorPolicy", "dependency-blocked":"dependencyBlocked", "native-git-change":"nativeGitChange",
      planning:"planning", execution:"execution", review:"review", idle:"idle", running:"running", waiting:"waiting", blocked:"blocked", done:"done", standby:"standby", error:"error", pending:"pending", queued:"queue", dispatched:"dispatch", failed:"error", approved:"approved", approve:"approve", revise:"revise", rejected:"rejected", reject:"reject", proposal:"proposal", question:"question", answer:"answer", objection:"objection", revision:"revision", handoff:"handoff", contract:"contract", consensus:"consensus", status:"status", intervention:"intervention"
    };
    let suppressDetailToggles = false;
    function label(key) { return (runtimeLabels[lang] && runtimeLabels[lang][key]) || runtimeLabels.en[key] || t(key); }
    function enumLabel(value) {
      const raw = String(value ?? "");
      if (raw === "") return label("none");
      const mapped = enumKeyMap[raw] ?? enumKeyMap[raw.toLowerCase()] ?? raw;
      return t(mapped) !== mapped ? t(mapped) : label(mapped) !== mapped ? label(mapped) : raw;
    }
    function optionalLabel(value) {
      if (value === undefined || value === null || value === "") return label("none");
      const raw = String(value);
      if (raw === "none") return label("none");
      if (raw === "n/a") return label("notAvailable");
      return enumLabel(raw);
    }
    function decisionReasonLabel(reason) {
      const raw = String(reason ?? "");
      if (raw === "No Republic ledger records exist yet.") return t("noTeam");
      if (raw === "No approve/revise/reject votes were recorded.") {
        return lang === "zh" ? "没有记录批准、修订或拒绝票。" :
          lang === "ja" ? "承認、修正、却下の票は記録されていません。" :
          lang === "ko" ? "승인, 수정, 거부 표가 기록되지 않았습니다." :
          raw;
      }
      return raw;
    }
    function applyI18n() {
      document.documentElement.lang = lang;
      const selector = document.getElementById("lang-select");
      if (selector) selector.value = lang;
      for (const node of document.querySelectorAll("[data-i18n]")) {
        node.textContent = t(node.getAttribute("data-i18n"));
      }
    }
    ${liveLoader}

    function metric(label, value) {
      return '<div class="metric"><span>' + safe(label) + '</span><strong>' + value + '</strong></div>';
    }

    function metricGroup(dataKey, title, rows) {
      return '<button class="metric-group metric-button" data-metric-group="' + safe(dataKey) + '"><h3>' + safe(title) + '</h3>' + rows.join("") + '</button>';
    }

    function safe(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    }

    function safeJson(value) {
      return safe(JSON.stringify(value ?? null, null, 2));
    }

    function truncate(value, limit = 260) {
      const text = String(value ?? "");
      return text.length > limit ? text.slice(0, limit - 1) + "..." : text;
    }

    function detailBlock(title, body, raw, detailKey) {
      const key = detailKey ? String(detailKey) : "";
      const keyAttr = key ? ' data-detail-key="' + safe(key) + '"' : "";
      const openAttr = key && openDetails.has(key) ? " open" : "";
      const action = openAttr ? label("collapse") : label("expand");
      return '<details class="detail-block"' + keyAttr + openAttr + '><summary><span class="summary-text">' + safe(title) + '</span><span class="summary-action">' + safe(action) + '</span></summary><div class="detail-body">' + body + (raw === undefined ? '' : '<pre class="raw-json">' + safeJson(raw) + '</pre>') + '</div></details>';
    }

    function captureOpenDetails() {
      for (const detail of document.querySelectorAll("details[data-detail-key]")) {
        const key = detail.getAttribute("data-detail-key");
        if (!key) continue;
        if (detail.open) openDetails.add(key);
      }
    }

    function syncDetailAction(detail) {
      const action = detail.querySelector(".summary-action");
      if (action) action.textContent = detail.open ? label("collapse") : label("expand");
    }

    function bindDetailState(root = document) {
      for (const detail of root.querySelectorAll("details[data-detail-key]")) {
        detail.addEventListener("toggle", () => {
          if (suppressDetailToggles) return;
          const key = detail.getAttribute("data-detail-key");
          if (!key) return;
          if (detail.open) openDetails.add(key);
          else openDetails.delete(key);
          syncDetailAction(detail);
        });
        syncDetailAction(detail);
      }
    }

    function fieldPill(label, value) {
      if (value === undefined || value === null || value === "") return "";
      return '<span class="pill">' + safe(label) + ': ' + safe(value) + '</span>';
    }

    function renderMessageDetails(message) {
      const target = message.targetSeatID ? ' -> ' + message.targetSeatID : '';
      const refs = (message.references ?? []).join(", ") || label("none");
      const files = (message.files ?? []).join(", ") || label("none");
      const meta = [
        fieldPill(label("channel"), optionalLabel(message.channel)),
        fieldPill(t("phase"), optionalLabel(message.phase)),
        fieldPill(label("round"), message.round ?? label("notAvailable")),
        fieldPill(label("status"), optionalLabel(message.status)),
        fieldPill("task", message.taskID),
        fieldPill(t("module"), message.module),
        fieldPill(label("references"), refs),
        fieldPill(label("files"), files),
      ].filter(Boolean).join("");
      const detailKey = "message:" + (message.id ?? [message.timestamp, message.authorSeatID, message.targetSeatID, message.messageType].filter(Boolean).join(":"));
      return '<div class="timeline-event ' + safe(message.messageType ?? "status") + '">' + detailBlock(
        message.authorSeatID + target + ' / ' + enumLabel(message.messageType),
        '<p>' + safe(truncate(message.content, 420)) + '</p><div class="item-meta">' + meta + '</div>',
        message,
        detailKey,
      ) + '</div>';
    }

    function renderQueueDetails(record) {
      const meta = [
        fieldPill(label("queue"), optionalLabel(record.queueType)),
        fieldPill(label("status"), optionalLabel(record.status)),
        fieldPill(label("target"), record.targetSeatID),
        fieldPill(label("requested"), record.requestedAgent),
        fieldPill(t("runtimeAgent"), record.runtimeAgent),
        fieldPill(t("task"), record.taskID),
      ].filter(Boolean).join("");
      return detailBlock(
        enumLabel(record.status ?? "queue") + ' / ' + enumLabel(record.queueType ?? "dispatch"),
        '<p>' + safe(record.summary ?? record.reason ?? "") + '</p><div class="item-meta">' + meta + '</div>',
        record,
        "queue:" + (record.id ?? [record.timestamp, record.targetSeatID, record.taskID, record.status].filter(Boolean).join(":")),
      );
    }

    function renderContractDetails(contract) {
      const terms = (contract.uncoveredTerms ?? []).length
        ? label("uncoveredTerms") + ': ' + contract.uncoveredTerms.join(", ")
        : label("allTermsCovered");
      const meta = [
        fieldPill(label("status"), optionalLabel(contract.status)),
        fieldPill(label("files"), (contract.files ?? []).join(", ") || label("none")),
      ].filter(Boolean).join("");
      return detailBlock(
        contract.contractID + ' / ' + enumLabel(contract.status),
        '<p>' + safe(terms) + '</p><div class="item-meta">' + meta + '</div>',
        contract,
        "contract:" + contract.contractID + ":" + contract.status,
      );
    }

    function statusClass(status) {
      return "status status-" + safe(status || "standby");
    }

    function seatStateByID(data) {
      const states = new Map();
      for (const state of data.seatStates ?? []) states.set(state.seatID, state);
      return states;
    }

    function seatDefs(data) {
      return data.teamManifest?.seats ?? [];
    }

    function seatStatus(data, seat) {
      return seatStateByID(data).get(seat.seatID)?.status ?? "standby";
    }

    function messagesForSeat(data, seatID) {
      return (data.commonsMessages ?? []).filter((message) => {
        if (message.authorSeatID === seatID || message.targetSeatID === seatID) return true;
        return (message.references ?? []).some((reference) => {
          const source = (data.commonsMessages ?? []).find((candidate) => candidate.messageID === reference);
          return source?.authorSeatID === seatID || source?.targetSeatID === seatID;
        });
      });
    }

    function relationKey(from, to) {
      return String(from ?? "") + "->" + String(to ?? "");
    }

    function normalizeMessageType(type) {
      return String(type ?? "status").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    }

    function communicationMessages(data) {
      return (data.commonsMessages ?? []).filter((message) =>
        message.authorSeatID && message.targetSeatID && message.authorSeatID !== message.targetSeatID
      );
    }

    function relationTone(type) {
      const normalized = normalizeMessageType(type);
      if (["question"].includes(normalized)) return "question";
      if (["answer", "consensus", "contract"].includes(normalized)) return "answer";
      if (["objection", "dependency-blocked", "error"].includes(normalized)) return "objection";
      if (["intervention", "supervisor-policy"].includes(normalized)) return "intervention";
      return "status";
    }

    function buildCommunicationRelations(data) {
      const byKey = new Map();
      for (const message of communicationMessages(data)) {
        const from = message.authorSeatID;
        const to = message.targetSeatID;
        const key = relationKey(from, to);
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            from,
            to,
            count: 0,
            typeCounts: {},
            latest: message,
            latestTimestamp: String(message.timestamp ?? ""),
            messages: [],
          });
        }
        const relation = byKey.get(key);
        const type = normalizeMessageType(message.messageType);
        relation.count += 1;
        relation.typeCounts[type] = (relation.typeCounts[type] ?? 0) + 1;
        relation.messages.push(message);
        const timestamp = String(message.timestamp ?? "");
        if (timestamp >= relation.latestTimestamp) {
          relation.latest = message;
          relation.latestTimestamp = timestamp;
        }
      }
      return Array.from(byKey.values()).sort((left, right) =>
        String(right.latestTimestamp).localeCompare(String(left.latestTimestamp)) || right.count - left.count
      );
    }

    function relationForKey(data, key) {
      return buildCommunicationRelations(data).find((relation) => relation.key === key) ?? null;
    }

    function seatLaneTitle(phase) {
      return phase === "all" ? t("all") : enumLabel(phase);
    }

    function renderCommunicationNode(data, seat) {
      const state = seatStateByID(data).get(seat.seatID);
      const status = state?.status ?? "standby";
      const selected = selectedSeatID === seat.seatID ? " selected" : "";
      return '<button class="comm-seat-node' + selected + '" data-comm-seat-id="' + safe(seat.seatID) + '" data-seat-id="' + safe(seat.seatID) + '">'
        + '<div class="comm-node-row"><strong>' + safe(seat.seatID) + '</strong><span class="' + statusClass(status) + '">' + safe(enumLabel(status)) + '</span></div>'
        + '<small><span class="comm-dot ' + safe(seat.phase ?? "idle") + '"></span> ' + safe(seat.role) + (seat.module ? ' / ' + safe(seat.module) : '') + '</small>'
        + '</button>';
    }

    function renderCommunicationMap(data) {
      const seats = seatDefs(data);
      const relations = buildCommunicationRelations(data);
      if (selectedRelationKey && !relations.some((relation) => relation.key === selectedRelationKey)) {
        selectedRelationKey = null;
      }
      const lanes = ["planning", "execution", "review", "idle"];
      const seatByLane = (lane) => seats.filter((seat) => seat.phase === lane || (lane === "idle" && seat.role === "supervisor"));
      const laneHtml = lanes.map((lane) => {
        const laneSeats = seatByLane(lane);
        if (laneSeats.length === 0) return "";
        return '<div class="comm-lane"><h4><span>' + safe(seatLaneTitle(lane)) + '</span><span>' + laneSeats.length + ' ' + t("seats") + '</span></h4><div class="comm-node-stack">' + laneSeats.map((seat) => renderCommunicationNode(data, seat)).join("") + '</div></div>';
      }).join("");
      const mapBody = relations.length
        ? '<div id="communication-map" class="communication-map" data-relation-count="' + relations.length + '"><svg id="communication-svg" class="comm-edge-svg" aria-hidden="true"></svg><div class="comm-lanes">' + laneHtml + '</div></div>'
        : '<div id="communication-map" class="communication-map" data-relation-count="0"><div class="communication-empty empty">' + t("noRelations") + '</div><div class="comm-lanes">' + laneHtml + '</div></div>';
      const legend = '<div class="comm-legend">'
        + '<span class="question"><i></i>' + safe(enumLabel("question")) + '</span>'
        + '<span class="answer"><i></i>' + safe(enumLabel("answer")) + '/' + safe(enumLabel("contract")) + '</span>'
        + '<span class="objection"><i></i>' + safe(enumLabel("objection")) + '</span>'
        + '<span class="intervention"><i></i>' + safe(enumLabel("intervention")) + '</span>'
        + '<span><i></i>' + safe(enumLabel("status")) + '</span>'
        + '</div>';
      return '<section class="board-section communication-section"><div class="board-section-head"><div><strong>' + t("communicationMap") + '</strong><p class="muted">' + t("communicationDesc") + '</p></div><span class="pill">' + relations.length + ' ' + label("messages") + '</span></div>' + mapBody + legend + '</section>';
    }

    function drawCommunicationEdges(data) {
      const map = document.getElementById("communication-map");
      const svg = document.getElementById("communication-svg");
      if (!map || !svg) return;
      const relations = buildCommunicationRelations(data);
      const mapRect = map.getBoundingClientRect();
      const nodes = new Map();
      for (const node of map.querySelectorAll("[data-comm-seat-id]")) {
        nodes.set(node.getAttribute("data-comm-seat-id"), node);
      }
      const defs = '<defs><marker id="comm-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3.5 L0,7 Z" fill="currentColor"></path></marker></defs>';
      const paths = relations.map((relation, index) => {
        const fromNode = nodes.get(relation.from);
        const toNode = nodes.get(relation.to);
        if (!fromNode || !toNode) return "";
        const fromRect = fromNode.getBoundingClientRect();
        const toRect = toNode.getBoundingClientRect();
        const fromCenterX = fromRect.left - mapRect.left + fromRect.width / 2;
        const toCenterX = toRect.left - mapRect.left + toRect.width / 2;
        const forward = toCenterX >= fromCenterX;
        const startX = (forward ? fromRect.right : fromRect.left) - mapRect.left;
        const startY = fromRect.top - mapRect.top + fromRect.height / 2;
        const endX = (forward ? toRect.left : toRect.right) - mapRect.left;
        const endY = toRect.top - mapRect.top + toRect.height / 2;
        const direction = forward ? 1 : -1;
        const controlX = startX + Math.max(70, Math.abs(endX - startX) * 0.45) * direction;
        const offset = ((index % 5) - 2) * 12;
        const controlY = (startY + endY) / 2 + offset;
        const width = Math.min(5, 1.5 + Math.log2(relation.count + 1));
        const selected = selectedRelationKey === relation.key ? " selected" : "";
        const tone = relationTone(relation.latest?.messageType);
        const d = "M " + startX.toFixed(1) + " " + startY.toFixed(1) + " Q " + controlX.toFixed(1) + " " + controlY.toFixed(1) + " " + endX.toFixed(1) + " " + endY.toFixed(1);
        return '<path class="comm-edge ' + safe(tone) + selected + '" data-relation-key="' + safe(relation.key) + '" d="' + safe(d) + '" style="stroke-width:' + width.toFixed(1) + '" marker-end="url(#comm-arrow)"><title>' + safe(relation.from + " -> " + relation.to + " (" + relation.count + ")") + '</title></path>';
      }).join("");
      svg.setAttribute("viewBox", "0 0 " + mapRect.width + " " + mapRect.height);
      svg.innerHTML = defs + paths;
      for (const edge of svg.querySelectorAll("[data-relation-key]")) {
        edge.addEventListener("click", (event) => {
          event.stopPropagation();
          selectedRelationKey = edge.getAttribute("data-relation-key");
          selectedSeatID = null;
          selectedMetric = null;
          renderInspector(currentData);
          drawCommunicationEdges(currentData);
        });
      }
    }

    function completionForSeat(data, seatID) {
      const messages = data.commonsMessages ?? [];
      const authoredQuestions = messages.filter((message) => message.authorSeatID === seatID && message.messageType === "question");
      const inboundQuestions = messages.filter((message) => message.targetSeatID === seatID && message.messageType === "question");
      const answeredAuthored = authoredQuestions.filter((question) => messages.some((message) => (message.references ?? []).includes(question.messageID) && ["answer","revision","consensus","contract"].includes(message.messageType))).length;
      const answeredInbound = inboundQuestions.filter((question) => messages.some((message) => (message.references ?? []).includes(question.messageID) && message.authorSeatID === seatID)).length;
      const total = authoredQuestions.length + inboundQuestions.length;
      const done = answeredAuthored + answeredInbound;
      return {
        total,
        done,
        percent: total === 0 ? 100 : Math.round((done / total) * 100),
        authoredQuestions: authoredQuestions.length,
        inboundQuestions: inboundQuestions.length,
      };
    }

    function contractsForSeat(data, seat) {
      const contracts = data.report.contractTraceability?.items ?? [];
      return contracts.filter((contract) => {
        if (seat.workgroupID && contract.contractID === seat.workgroupID) return true;
        const moduleName = seat.module ? String(seat.module).replace(/\\\\/g, "/") : "";
        return moduleName.length > 0 && contract.files.some((file) => String(file).replace(/\\\\/g, "/").startsWith(moduleName + "/"));
      });
    }

    function schedulerRecordsForSeat(data, seatID) {
      return (data.schedulerQueueRecords ?? []).filter((record) => record.targetSeatID === seatID);
    }

    function pendingSchedulerRecordsForSeat(data, seatID) {
      return schedulerRecordsForSeat(data, seatID).filter((record) => ["queued","pending","failed"].includes(record.status));
    }

    function statusCounts(data, seats) {
      const states = seatStateByID(data);
      const count = (status) => seats.filter((seat) => (states.get(seat.seatID)?.status ?? "standby") === status).length;
      return {
        running: count("running"),
        waiting: count("waiting"),
        blocked: count("blocked") + count("error"),
        done: count("done"),
        standby: count("standby"),
      };
    }

    function idleAwaitingClosure(data, counts) {
      return Boolean(data.teamPhase)
        && data.teamPhase.status === "in-progress"
        && counts.running === 0
        && counts.waiting === 0
        && counts.blocked === 0
        && (data.report.schedulerQueue?.pending ?? 0) === 0;
    }

    function pillClass(value, warnAtOne) {
      if (value === 0) return "pill good";
      return warnAtOne ? "pill warn" : "pill";
    }

    function renderSeatCard(data, seat) {
      const state = seatStateByID(data).get(seat.seatID);
      const status = state?.status ?? "standby";
      const selected = selectedSeatID === seat.seatID ? " selected" : "";
      const completion = completionForSeat(data, seat.seatID);
      const pendingQueue = pendingSchedulerRecordsForSeat(data, seat.seatID).length;
      const relatedMessages = messagesForSeat(data, seat.seatID).length;
      return '<button class="seat-card' + selected + '" data-seat-id="' + safe(seat.seatID) + '">'
        + '<div class="seat-top"><span class="seat-name">' + safe(seat.seatID) + '</span><span class="' + statusClass(status) + '">' + safe(enumLabel(status)) + '</span></div>'
        + '<div class="seat-meta">' + safe(seat.role) + (seat.module ? ' / ' + safe(seat.module) : '') + '</div>'
        + '<div class="seat-foot"><span class="pill">' + label("threads") + ' ' + completion.done + '/' + completion.total + '</span><span class="' + pillClass(pendingQueue, true) + '">' + label("queue") + ' ' + pendingQueue + '</span><span class="pill">' + label("messages") + ' ' + relatedMessages + '</span></div>'
        + '</button>';
    }

    function renderPhaseStrip(data) {
      const activePhase = data.teamPhase?.phase ?? "idle";
      const counts = statusCounts(data, seatDefs(data));
      const awaitingClosure = idleAwaitingClosure(data, counts);
      const phases = ["all", "planning", "execution", "review", "idle"];
      const phaseSeats = (phase) => phase === "all"
        ? seatDefs(data)
        : seatDefs(data).filter((seat) => seat.phase === phase || (phase === "idle" && seat.role === "supervisor"));
      const phaseCounts = phases.map((phase) => phaseSeats(phase).length);
      const maxCount = Math.max(1, ...phaseCounts);
      return '<div class="phase-strip">' + phases.map((phase) => {
        const count = phaseSeats(phase).length;
        const active = phase !== "all" && phase === activePhase ? " active" : "";
        const selected = selectedPhase === phase ? " selected" : "";
        const width = Math.max(6, Math.round((count / maxCount) * 100));
        const phaseLabel = phase === "all" ? t("workgroupLabel") : (phase === activePhase ? (awaitingClosure ? t("idleClosure") : enumLabel(data.teamPhase?.status ?? "active")) : enumLabel("standby"));
        const title = phase === "all" ? t("all") : enumLabel(phase);
        return '<button class="phase-card' + active + selected + '" data-phase-filter="' + safe(phase) + '"><div class="phase-title"><strong>' + safe(title) + '</strong><span>' + count + ' ' + t("seats") + '</span></div><div class="muted">' + safe(phaseLabel) + '</div><div class="phase-meter"><div style="width:' + width + '%"></div></div></button>';
      }).join("") + '</div>';
    }

    function renderTeamBoard(data) {
      const seats = seatDefs(data);
      const phaseMatches = (seat) => selectedPhase === "all" || seat.phase === selectedPhase || (selectedPhase === "idle" && seat.role === "supervisor");
      const visibleSeats = seats.filter(phaseMatches);
      const supervisors = visibleSeats.filter((seat) => seat.role === "supervisor");
      const workerSeats = visibleSeats.filter((seat) => seat.role !== "supervisor");
      const counts = statusCounts(data, seats);
      const workgroups = new Map();
      for (const seat of workerSeats) {
        const key = seat.workgroupID ?? "unassigned";
        if (!workgroups.has(key)) workgroups.set(key, []);
        workgroups.get(key).push(seat);
      }
      const board = document.getElementById("team-board");
      const awaitingClosure = idleAwaitingClosure(data, counts);
      document.getElementById("board-subtitle").textContent = data.teamPhase
        ? enumLabel(data.teamPhase.phase) + " / " + enumLabel(data.teamPhase.status) + " / " + label("round") + " " + (data.teamPhase.activeRound ?? label("notAvailable")) + (awaitingClosure ? " / " + t("idleClosure") : "")
        : t("noTeam");
      document.getElementById("board-pills").innerHTML = [
        '<span class="pill">' + safe(data.teamManifest?.teamModel ?? label("noTeamShort")) + '</span>',
        '<span class="pill">' + t("allocation") + ' ' + safe(optionalLabel(data.teamManifest?.seatAllocation)) + '</span>',
        '<span class="pill">' + t("maxParallel") + ' ' + safe(data.teamManifest?.maxParallelSeats ?? label("notAvailable")) + '</span>',
        '<span class="pill">' + t("seats") + ' ' + seats.length + '</span>',
        '<span class="' + pillClass(data.report.schedulerQueue?.pending ?? 0, true) + '">' + label("pending") + ' ' + safe(data.report.schedulerQueue?.pending ?? 0) + '</span>',
        '<span class="' + pillClass(data.report.contractTraceability?.warningCount ?? 0, true) + '">' + t("contractWarnings").toLowerCase() + ' ' + safe(data.report.contractTraceability?.warningCount ?? 0) + '</span>',
      ].join("");
      if (seats.length === 0) {
        board.innerHTML = '<div class="empty">' + t("noTeam") + '</div>';
        return;
      }
      const supervisorHtml = supervisors.length
        ? '<section class="board-section supervisor-zone"><div class="board-section-head"><strong>' + t("supervisorLane") + '</strong><span class="pill">' + supervisors.length + ' ' + t("seats") + '</span></div><div class="seat-orbit">' + supervisors.map((seat) => renderSeatCard(data, seat)).join("") + '</div></section>'
        : "";
      const workgroupHtml = '<div class="workgroup-grid">' + Array.from(workgroups.entries()).map(([workgroupID, group]) => {
        const groupCounts = statusCounts(data, group);
        const pending = group.reduce((total, seat) => total + pendingSchedulerRecordsForSeat(data, seat.seatID).length, 0);
        return '<div class="workgroup-card"><div class="workgroup-head"><div><strong>' + safe(workgroupID) + '</strong><small>' + group.length + ' ' + t("seats") + ' ' + label("assigned") + '</small></div><span class="' + pillClass(pending, true) + '">' + label("queue") + ' ' + pending + '</span></div><div class="workgroup-stats"><div class="stat-chip"><span>' + t("running") + '</span><strong>' + groupCounts.running + '</strong></div><div class="stat-chip"><span>' + t("waiting") + '</span><strong>' + groupCounts.waiting + '</strong></div><div class="stat-chip"><span>' + t("blocked") + '</span><strong>' + groupCounts.blocked + '</strong></div></div><div class="seat-list">' + group.map((seat) => renderSeatCard(data, seat)).join("") + '</div></div>';
      }).join("") + '</div>';
      board.innerHTML = renderPhaseStrip(data)
        + '<section class="board-section"><div class="board-section-head"><strong>' + t("teamLoad") + '</strong><span class="pill">' + counts.running + ' ' + t("running") + ' / ' + counts.waiting + ' ' + t("waiting") + ' / ' + counts.blocked + ' ' + t("blocked") + '</span></div>' + (awaitingClosure ? '<div class="empty">' + t("awaitingClosure") + '</div>' : '') + '</section>'
        + renderCommunicationMap(data)
        + supervisorHtml
        + '<section class="board-section"><div class="board-section-head"><strong>' + t("workgroupLabel") + '</strong><span class="pill">' + workgroups.size + ' ' + label("groups") + '</span></div>' + workgroupHtml + '</section>';
      for (const button of board.querySelectorAll("[data-phase-filter]")) {
        button.addEventListener("click", () => {
          selectedPhase = button.getAttribute("data-phase-filter") || "all";
          selectedSeatID = null;
          selectedMetric = null;
          selectedRelationKey = null;
          renderTeamBoard(currentData);
          renderInspector(currentData);
        });
      }
      for (const button of board.querySelectorAll("[data-seat-id]")) {
        button.addEventListener("click", () => {
          selectedSeatID = button.getAttribute("data-seat-id");
          selectedMetric = null;
          selectedRelationKey = null;
          renderTeamBoard(currentData);
          renderInspector(currentData);
        });
      }
      requestAnimationFrame(() => drawCommunicationEdges(data));
    }

    function renderMetrics(data) {
      const decision = data.report.decision;
      document.getElementById("repo-pill").textContent = data.repository ? data.repository.repoRoot : label("noGitRepository");
      document.getElementById("refresh-pill").textContent = label("updated") + " " + new Date(data.generatedAt).toLocaleTimeString();
      const seats = seatDefs(data);
      const counts = statusCounts(data, seats);
      const workgroupCount = new Set(seats.map((seat) => seat.workgroupID).filter(Boolean)).size;
      document.getElementById("metrics").innerHTML =
        '<button class="decision-card metric-button" data-metric-group="decision"><span class="muted">' + t("decision") + '</span><strong class="' + (colors[decision.status] ?? "") + '">' + safe(enumLabel(decision.status)) + '</strong><p>' + safe(decisionReasonLabel(decision.reason)) + '</p></button>'
        + metricGroup("team", t("team"), [
          metric(t("model"), safe(optionalLabel(data.teamManifest?.teamModel))),
          metric(t("allocation"), safe(optionalLabel(data.teamManifest?.seatAllocation))),
          metric(t("phase"), safe(data.teamPhase ? enumLabel(data.teamPhase.phase) + "/" + enumLabel(data.teamPhase.status) : label("none"))),
          metric(t("workgroups"), workgroupCount),
          metric(t("seats"), seats.length),
        ])
        + metricGroup("runtime", t("runtime"), [
          metric(t("defaultRuntime"), safe(optionalLabel(data.teamManifest?.defaultRuntimeAgent))),
          metric(t("maxParallel"), safe(data.teamManifest?.maxParallelSeats ?? label("notAvailable"))),
          metric(t("planningSeats"), seats.filter((seat) => seat.phase === "planning").length),
          metric(t("executionSeats"), seats.filter((seat) => seat.phase === "execution").length),
          metric(t("reviewSeats"), seats.filter((seat) => seat.phase === "review").length),
        ])
        + metricGroup("seatState", t("seatState"), [
          metric(t("running"), counts.running),
          metric(t("waiting"), counts.waiting),
          metric(t("blocked"), counts.blocked),
          metric(t("done"), counts.done),
          metric(t("standby"), counts.standby),
        ])
        + metricGroup("records", t("records"), [
          metric(t("commons"), data.report.commons.messageCount),
          metric(t("targeted"), data.report.commons.targetedMessages),
          metric(t("referenced"), data.report.commons.referencedMessages),
          metric(t("nativeGit"), data.report.nativeGit.recordCount),
        ])
        + metricGroup("governance", t("governanceGroup"), [
          metric(t("pendingDispatches"), data.report.schedulerQueue?.pending ?? 0),
          metric(t("queuedRecords"), data.report.schedulerQueue?.queued ?? 0),
          metric(t("dispatchedTasks"), data.report.schedulerQueue?.dispatched ?? 0),
          metric(t("contracts"), data.report.contractTraceability?.contractCount ?? 0),
          metric(t("contractWarnings"), data.report.contractTraceability?.warningCount ?? 0),
        ]);
      for (const button of document.querySelectorAll("[data-metric-group]")) {
        button.addEventListener("click", () => {
          selectedMetric = button.getAttribute("data-metric-group");
          selectedSeatID = null;
          selectedRelationKey = null;
          renderInspector(currentData);
        });
      }
    }

    function renderInspector(data) {
      const inspector = document.getElementById("seat-inspector");
      if (selectedRelationKey) {
        const relation = relationForKey(data, selectedRelationKey);
        if (relation) {
          const sortedMessages = relation.messages.sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")));
          const typeRows = Object.entries(relation.typeCounts)
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([type, count]) => metric(enumLabel(type), count))
            .join("");
          inspector.innerHTML = '<h2>' + t("seatInspector") + '</h2>'
            + '<div class="relation-summary"><h3>' + t("selectedRelation") + '</h3><div class="relation-pair"><span>' + safe(relation.from) + '</span><span class="relation-arrow">-></span><span>' + safe(relation.to) + '</span></div><p class="muted">' + relation.count + ' ' + label("messages") + ' · ' + t("latestMessage") + ': ' + safe(relation.latestTimestamp || label("notAvailable")) + '</p></div>'
            + '<div>' + [
              metric(t("from"), safe(relation.from)),
              metric(t("to"), safe(relation.to)),
              metric(t("messageTypes"), safe(Object.keys(relation.typeCounts).map(enumLabel).join(", ") || label("none"))),
            ].join("") + '</div>'
            + detailBlock(t("messageTypes"), typeRows, relation.typeCounts, "relation-types:" + relation.key)
            + '<div><h3>' + t("relationMessages") + '</h3><div class="inspector-list">' + sortedMessages.slice(0, 16).map(renderMessageDetails).join("") + '</div></div>'
            + detailBlock(label("rawData"), "", relation, "relation-raw:" + relation.key);
          bindDetailState(inspector);
          return;
        }
        selectedRelationKey = null;
      }
      if (selectedMetric) {
        const rawByMetric = {
          decision: data.report.decision,
          team: { manifest: data.teamManifest, phase: data.teamPhase },
          runtime: data.teamManifest,
          seatState: data.seatStates,
          records: {
            commons: data.report.commons,
            nativeGit: data.report.nativeGit,
            ledger: data.report.republic,
          },
          governance: {
            schedulerQueue: data.report.schedulerQueue,
            contractTraceability: data.report.contractTraceability,
          },
        };
        inspector.innerHTML = '<h2>' + t("seatInspector") + '</h2>'
          + '<div class="inspector-title"><strong>' + safe(t(selectedMetric) !== selectedMetric ? t(selectedMetric) : selectedMetric) + '</strong><p class="muted">' + t("noMetric") + '</p></div>'
          + detailBlock(label("rawData"), "", rawByMetric[selectedMetric] ?? null, "metric:" + selectedMetric);
        bindDetailState(inspector);
        return;
      }
      const seats = seatDefs(data);
      if (!selectedSeatID && seats.length > 0) {
        const activeSeat = seats.find((seat) => ["blocked","waiting","running"].includes(seatStatus(data, seat))) ?? seats[0];
        selectedSeatID = activeSeat.seatID;
      }
      const seat = seats.find((candidate) => candidate.seatID === selectedSeatID);
      if (!seat) {
        inspector.innerHTML = '<h2>' + t("seatInspector") + '</h2><div class="empty">' + t("clickSeat") + '</div>';
        return;
      }
      const state = seatStateByID(data).get(seat.seatID);
      const related = messagesForSeat(data, seat.seatID).sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")));
      const completion = completionForSeat(data, seat.seatID);
      const contracts = contractsForSeat(data, seat);
      const queueRecords = schedulerRecordsForSeat(data, seat.seatID).sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")));
      const waitingOn = (state?.status === "waiting" || state?.status === "blocked") ? (state?.waitingOn ?? []) : [];
      inspector.innerHTML = '<h2>' + t("seatInspector") + '</h2>'
        + '<div class="inspector-title"><strong>' + safe(seat.seatID) + '</strong><span class="' + statusClass(state?.status ?? "standby") + '">' + safe(enumLabel(state?.status ?? "standby")) + '</span><p class="muted">' + safe(seat.role) + '</p></div>'
        + detailBlock(t("seatDefinition"), '<p>' + safe(seat.reason ?? label("noAllocationReason")) + '</p>', seat, "seat-definition:" + seat.seatID)
        + detailBlock(t("currentState"), '<p>' + safe(state?.memory ?? label("noLiveStateMemory")) + '</p>', state ?? null, "seat-state:" + seat.seatID)
        + '<div>' + [
          metric(t("phase"), safe(optionalLabel(state?.phase ?? seat.phase))),
          metric(t("workgroups"), safe(optionalLabel(state?.workgroupID ?? seat.workgroupID))),
          metric(t("module"), safe(optionalLabel(state?.module ?? seat.module))),
          metric(t("runtimeAgent"), safe(optionalLabel(state?.runtimeAgent ?? seat.runtimeAgent))),
          metric(t("conceptualAgent"), safe(optionalLabel(state?.conceptualAgent ?? seat.conceptualAgent))),
          metric(t("waitingOn"), safe(waitingOn.join(", ") || label("none"))),
          metric(t("task"), safe(optionalLabel(state?.taskID ?? seat.taskID))),
        ].join("") + '</div>'
        + '<div><h3>' + t("interactionCompletion") + '</h3><div class="progress"><div style="width:' + completion.percent + '%"></div></div><p class="muted">' + completion.done + ' / ' + completion.total + ' ' + label("questionThreadsCompleted") + '. ' + label("authoredQuestions") + ': ' + completion.authoredQuestions + '. ' + label("inboundQuestions") + ': ' + completion.inboundQuestions + '.</p></div>'
        + '<div><h3>' + t("schedulerQueue") + '</h3><div class="inspector-list">' + (queueRecords.length ? queueRecords.slice(0, 8).map(renderQueueDetails).join("") : '<div class="empty">' + t("noQueue") + '</div>') + '</div></div>'
        + '<div><h3>' + t("contractTraceability") + '</h3><div class="inspector-list">' + (contracts.length ? contracts.map(renderContractDetails).join("") : '<div class="empty">' + t("noContract") + '</div>') + '</div></div>'
        + '<div><h3>' + t("recentInteractions") + '</h3><div class="inspector-list">' + (related.length ? related.slice(0, 10).map(renderMessageDetails).join("") : '<div class="empty">' + t("noInteractions") + '</div>') + '</div></div>';
      bindDetailState(inspector);
    }

    function renderTimeline(data) {
      const timeline = document.getElementById("timeline");
      if (!timeline) return;
      const messages = [...(data.commonsMessages ?? [])].sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))).slice(-30).reverse();
      timeline.innerHTML = messages.length
        ? messages.map(renderMessageDetails).join("")
        : '<div class="empty">' + t("noTimeline") + '</div>';
      bindDetailState(timeline);
    }

    async function render() {
      captureOpenDetails();
      const data = await loadData();
      currentData = data;
      applyI18n();
      renderMetrics(data);
      renderTeamBoard(data);
      renderInspector(data);
      renderTimeline(data);
    }

    document.getElementById("lang-select").addEventListener("change", (event) => {
      lang = event.target.value;
      localStorage.setItem("omo-republic-lang", lang);
      applyI18n();
      if (currentData) render();
    });
    window.addEventListener("resize", () => {
      if (currentData) requestAnimationFrame(() => drawCommunicationEdges(currentData));
    });
    applyI18n();
    render();
    ${options.live ? `setInterval(render, ${refreshMs});` : ""}
  </script>
</body>
</html>`
}

export function writeRepublicDashboardFile(options: RepublicDashboardOptions = {}): string {
  const data = buildRepublicDashboardData(options)
  if (!data.repository) {
    throw new Error("Not inside a git repository. Cannot choose a default Republic dashboard path.")
  }
  const outputPath = defaultDashboardPath(data.repository, options.output)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, renderRepublicDashboardHtml(data, { refreshMs: options.refreshMs }), "utf-8")
  return outputPath
}

export interface RepublicDashboardServerHandle {
  url: string
  stop: () => void
}

export function startRepublicDashboardServer(options: RepublicDashboardOptions): RepublicDashboardServerHandle | null {
  const port = options.port ?? 4097
  const initialData = buildRepublicDashboardData(options)
  if (!initialData.repository) {
    return null
  }
  const resolvedOptions: RepublicDashboardOptions = {
    ...options,
    directory: initialData.repository.repoRoot,
  }

  const server = Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/data.json") {
        return Response.json(buildRepublicDashboardData(resolvedOptions), {
          headers: {
            "cache-control": "no-store",
          },
        })
      }
      return new Response(
        renderRepublicDashboardHtml(buildRepublicDashboardData(resolvedOptions), {
          live: true,
          refreshMs: options.refreshMs,
        }),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      )
    },
  })

  const url = `http://127.0.0.1:${server.port}`
  return {
    url,
    stop: () => server.stop(true),
  }
}

async function serveRepublicDashboard(options: RepublicDashboardOptions): Promise<number> {
  const server = startRepublicDashboardServer(options)
  if (!server) {
    console.error("Not inside a git repository. Cannot serve Republic dashboard.")
    return 1
  }

  if (options.open) {
    openDashboardTarget(server.url)
  }
  console.log(`OMO Republic dashboard serving at ${server.url}`)
  await new Promise(() => {})
  return 0
}

export async function republicDashboard(options: RepublicDashboardOptions = {}): Promise<number> {
  const data = buildRepublicDashboardData(options)
  if (options.json) {
    console.log(JSON.stringify(data, null, 2))
    return data.repository ? 0 : 1
  }

  if (options.serve) {
    return serveRepublicDashboard(options)
  }

  if (!data.repository) {
    console.error("Not inside a git repository. No Republic dashboard was written.")
    return 1
  }

  const outputPath = writeRepublicDashboardFile(options)
  if (options.open) {
    openDashboardTarget(outputPath)
  }
  console.log(`OMO Republic dashboard written to ${outputPath}`)
  return 0
}
