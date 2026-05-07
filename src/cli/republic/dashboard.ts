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
    ? `async function loadData(){ const response = await fetch("/data.json", { cache: "no-store" }); return await response.json(); }`
    : `async function loadData(){ return JSON.parse(document.getElementById("republic-data").textContent); }`

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
    .metric { display:flex; justify-content:space-between; gap:16px; padding:8px 0; border-bottom:1px solid rgba(48,56,66,.72); }
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
    .phase-strip { display:grid; grid-template-columns:repeat(4, minmax(130px, 1fr)); gap:10px; }
    .phase-card { border:1px solid var(--line); border-radius:8px; padding:11px; background:var(--panel2); min-height:86px; }
    .phase-card.active { border-color:var(--accent); box-shadow:0 0 0 1px rgba(79,140,255,.22) inset; }
    .phase-title { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:9px; }
    .phase-title strong { font-size:13px; text-transform:uppercase; }
    .phase-title span { color:var(--muted); font-size:12px; }
    .phase-meter { height:4px; border-radius:999px; background:#232b36; overflow:hidden; margin-top:10px; }
    .phase-meter div { height:100%; background:var(--accent); }
    .board-section { border:1px solid var(--soft-line); border-radius:8px; background:rgba(16,20,27,.82); overflow:hidden; }
    .board-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 14px; border-bottom:1px solid var(--soft-line); background:#151b24; }
    .board-section-head strong { font-size:14px; }
    .supervisor-zone { border-color:rgba(176,140,255,.42); }
    .workgroup-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:12px; padding:12px; }
    .workgroup-card { border:1px solid var(--line); border-radius:8px; background:#10151d; overflow:hidden; }
    .workgroup-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:12px; border-bottom:1px solid var(--soft-line); background:#121923; }
    .workgroup-head strong { display:block; font-size:14px; overflow-wrap:anywhere; }
    .workgroup-head small { display:block; color:var(--muted); margin-top:3px; }
    .workgroup-stats { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; padding:10px 12px 0; }
    .stat-chip { border:1px solid var(--soft-line); border-radius:8px; padding:7px; background:#0c1016; }
    .stat-chip span { display:block; color:var(--muted); font-size:11px; }
    .stat-chip strong { font-size:15px; }
    .seat-list { display:flex; flex-direction:column; gap:8px; padding:12px; }
    .seat-card { width:100%; text-align:left; border:1px solid var(--line); border-radius:8px; padding:10px; background:#0d1117; color:var(--text); cursor:pointer; transition:border-color .12s ease, background .12s ease; }
    .seat-card:hover, .seat-card.selected { border-color:var(--accent); background:#111a27; }
    .seat-top { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:5px; }
    .seat-name { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .seat-meta { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .seat-foot { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
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
    .item strong { display:block; margin-bottom:4px; overflow-wrap:anywhere; }
    .item p { margin:0; color:var(--muted); overflow-wrap:anywhere; }
    .item small { color:var(--muted); overflow-wrap:anywhere; }
    .inspector { display:flex; flex-direction:column; gap:16px; }
    .inspector-title { border:1px solid var(--line); border-radius:8px; padding:12px; background:#0d1117; }
    .inspector-title strong { display:block; font-size:16px; margin-bottom:6px; overflow-wrap:anywhere; }
    .progress { height:8px; border-radius:999px; overflow:hidden; background:#232b36; }
    .progress div { height:100%; background:var(--green); width:0; }
    .detail-block { border:1px solid var(--soft-line); border-radius:8px; background:#0d1117; overflow:hidden; }
    details.detail-block summary { cursor:pointer; list-style:none; padding:10px 12px; color:var(--text); font-weight:700; border-bottom:1px solid var(--soft-line); }
    details.detail-block summary::-webkit-details-marker { display:none; }
    details.detail-block summary::after { content:"expand"; float:right; color:var(--muted); font-weight:400; font-size:11px; text-transform:uppercase; }
    details.detail-block[open] summary::after { content:"collapse"; }
    .detail-body { padding:10px 12px; color:var(--muted); overflow-wrap:anywhere; }
    .detail-body p { margin-bottom:8px; }
    .raw-json { margin:0; max-height:320px; overflow:auto; white-space:pre-wrap; color:#cbd5e1; font:12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .item-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .summary-line { display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .empty { border:1px dashed var(--line); border-radius:8px; padding:14px; color:var(--muted); background:#0d1117; }
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
    <h1>OMO Republic Dashboard</h1>
    <div class="header-pills"><span id="repo-pill" class="pill"></span><span id="refresh-pill" class="pill"></span></div>
  </header>
  <main class="dashboard-shell">
    <aside class="summary-panel pad">
      <div class="section-heading"><h2>Governance Snapshot</h2><p>Decision, dispatch pressure, and traceability health.</p></div>
      <div id="metrics"></div>
    </aside>
    <section class="workspace">
      <div class="workspace-header">
        <div>
          <h2>Command Board</h2>
          <p id="board-subtitle"></p>
        </div>
        <div id="board-pills"></div>
      </div>
      <div id="team-board" class="board" aria-label="OMO Republic team board"></div>
      <section class="timeline-panel" aria-label="Commons timeline">
        <div class="section-heading"><h2>Commons Timeline</h2><p>Recent proposals, questions, answers, objections, contracts, and supervisor notes.</p></div>
        <div id="timeline" class="timeline"></div>
      </section>
    </section>
    <aside class="inspector-panel pad right">
      <div id="seat-inspector" class="inspector"></div>
    </aside>
  </main>
  <script>
    const colors = { approved:"status-approved", blocked:"status-blocked", "needs-quorum":"status-needs-quorum", revise:"status-revise" };
    let currentData = null;
    let selectedSeatID = null;
    ${liveLoader}

    function metric(label, value) {
      return '<div class="metric"><span>' + label + '</span><strong>' + value + '</strong></div>';
    }

    function safe(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    }

    function safeJson(value) {
      return safe(JSON.stringify(value ?? null, null, 2));
    }

    function detailBlock(title, body, raw) {
      return '<details class="detail-block"><summary>' + safe(title) + '</summary><div class="detail-body">' + body + (raw === undefined ? '' : '<pre class="raw-json">' + safeJson(raw) + '</pre>') + '</div></details>';
    }

    function fieldPill(label, value) {
      if (value === undefined || value === null || value === "") return "";
      return '<span class="pill">' + safe(label) + ': ' + safe(value) + '</span>';
    }

    function renderMessageDetails(message) {
      const target = message.targetSeatID ? ' -> ' + message.targetSeatID : '';
      const refs = (message.references ?? []).join(", ") || "none";
      const files = (message.files ?? []).join(", ") || "none";
      const meta = [
        fieldPill("channel", message.channel),
        fieldPill("phase", message.phase),
        fieldPill("round", message.round ?? "n/a"),
        fieldPill("status", message.status ?? "n/a"),
        fieldPill("task", message.taskID),
        fieldPill("module", message.module),
        fieldPill("refs", refs),
        fieldPill("files", files),
      ].filter(Boolean).join("");
      return detailBlock(
        message.authorSeatID + target + ' / ' + message.messageType,
        '<p>' + safe(message.content) + '</p><div class="item-meta">' + meta + '</div>',
        message,
      );
    }

    function renderQueueDetails(record) {
      const meta = [
        fieldPill("queue", record.queueType),
        fieldPill("status", record.status),
        fieldPill("target", record.targetSeatID),
        fieldPill("requested", record.requestedAgent),
        fieldPill("runtime", record.runtimeAgent),
        fieldPill("task", record.taskID),
      ].filter(Boolean).join("");
      return detailBlock(
        (record.status ?? "queue") + ' / ' + (record.queueType ?? "dispatch"),
        '<p>' + safe(record.summary ?? record.reason ?? "") + '</p><div class="item-meta">' + meta + '</div>',
        record,
      );
    }

    function renderContractDetails(contract) {
      const terms = (contract.uncoveredTerms ?? []).length
        ? 'Uncovered terms: ' + contract.uncoveredTerms.join(", ")
        : "All extracted hard terms are covered.";
      const meta = [
        fieldPill("status", contract.status),
        fieldPill("files", (contract.files ?? []).join(", ") || "none"),
      ].filter(Boolean).join("");
      return detailBlock(
        contract.contractID + ' / ' + contract.status,
        '<p>' + safe(terms) + '</p><div class="item-meta">' + meta + '</div>',
        contract,
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
        + '<div class="seat-top"><span class="seat-name">' + safe(seat.seatID) + '</span><span class="' + statusClass(status) + '">' + safe(status) + '</span></div>'
        + '<div class="seat-meta">' + safe(seat.role) + (seat.module ? ' / ' + safe(seat.module) : '') + '</div>'
        + '<div class="seat-foot"><span class="pill">threads ' + completion.done + '/' + completion.total + '</span><span class="' + pillClass(pendingQueue, true) + '">queue ' + pendingQueue + '</span><span class="pill">msgs ' + relatedMessages + '</span></div>'
        + '</button>';
    }

    function renderPhaseStrip(data) {
      const activePhase = data.teamPhase?.phase ?? "idle";
      const counts = statusCounts(data, seatDefs(data));
      const awaitingClosure = idleAwaitingClosure(data, counts);
      const phases = ["planning", "execution", "review", "idle"];
      const phaseCounts = phases.map((phase) => seatDefs(data).filter((seat) => seat.phase === phase || (phase === "idle" && seat.role === "supervisor")).length);
      const maxCount = Math.max(1, ...phaseCounts);
      return '<div class="phase-strip">' + phases.map((phase) => {
        const count = seatDefs(data).filter((seat) => seat.phase === phase || (phase === "idle" && seat.role === "supervisor")).length;
        const active = phase === activePhase ? " active" : "";
        const width = Math.max(6, Math.round((count / maxCount) * 100));
        const label = phase === activePhase ? (awaitingClosure ? "idle, awaiting closure" : (data.teamPhase?.status ?? "active")) : "standby";
        return '<div class="phase-card' + active + '"><div class="phase-title"><strong>' + safe(phase) + '</strong><span>' + count + ' seats</span></div><div class="muted">' + safe(label) + '</div><div class="phase-meter"><div style="width:' + width + '%"></div></div></div>';
      }).join("") + '</div>';
    }

    function renderTeamBoard(data) {
      const seats = seatDefs(data);
      const supervisors = seats.filter((seat) => seat.role === "supervisor");
      const workerSeats = seats.filter((seat) => seat.role !== "supervisor");
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
        ? data.teamPhase.phase + " / " + data.teamPhase.status + " / round " + (data.teamPhase.activeRound ?? "n/a") + (awaitingClosure ? " / agents idle, awaiting closure" : "")
        : "No active Republic team phase.";
      document.getElementById("board-pills").innerHTML = [
        '<span class="pill">' + safe(data.teamManifest?.teamModel ?? "no team") + '</span>',
        '<span class="pill">allocation ' + safe(data.teamManifest?.seatAllocation ?? "none") + '</span>',
        '<span class="pill">max parallel ' + safe(data.teamManifest?.maxParallelSeats ?? "n/a") + '</span>',
        '<span class="pill">seats ' + seats.length + '</span>',
        '<span class="' + pillClass(data.report.schedulerQueue?.pending ?? 0, true) + '">pending ' + safe(data.report.schedulerQueue?.pending ?? 0) + '</span>',
        '<span class="' + pillClass(data.report.contractTraceability?.warningCount ?? 0, true) + '">contract warnings ' + safe(data.report.contractTraceability?.warningCount ?? 0) + '</span>',
      ].join("");
      if (seats.length === 0) {
        board.innerHTML = '<div class="empty">No persistent Republic team has been initialized yet.</div>';
        return;
      }
      const supervisorHtml = supervisors.length
        ? '<section class="board-section supervisor-zone"><div class="board-section-head"><strong>Supervisor Lane</strong><span class="pill">' + supervisors.length + ' seats</span></div><div class="seat-list">' + supervisors.map((seat) => renderSeatCard(data, seat)).join("") + '</div></section>'
        : "";
      const workgroupHtml = '<div class="workgroup-grid">' + Array.from(workgroups.entries()).map(([workgroupID, group]) => {
        const groupCounts = statusCounts(data, group);
        const pending = group.reduce((total, seat) => total + pendingSchedulerRecordsForSeat(data, seat.seatID).length, 0);
        return '<div class="workgroup-card"><div class="workgroup-head"><div><strong>' + safe(workgroupID) + '</strong><small>' + group.length + ' seats assigned</small></div><span class="' + pillClass(pending, true) + '">queue ' + pending + '</span></div><div class="workgroup-stats"><div class="stat-chip"><span>Running</span><strong>' + groupCounts.running + '</strong></div><div class="stat-chip"><span>Waiting</span><strong>' + groupCounts.waiting + '</strong></div><div class="stat-chip"><span>Blocked</span><strong>' + groupCounts.blocked + '</strong></div></div><div class="seat-list">' + group.map((seat) => renderSeatCard(data, seat)).join("") + '</div></div>';
      }).join("") + '</div>';
      board.innerHTML = renderPhaseStrip(data)
        + '<section class="board-section"><div class="board-section-head"><strong>Team Load</strong><span class="pill">' + counts.running + ' running / ' + counts.waiting + ' waiting / ' + counts.blocked + ' blocked</span></div>' + (awaitingClosure ? '<div class="empty">No seat or scheduler work is active. The team phase is still open, so publish a final review/phase update or inspect warnings before treating this run as complete.</div>' : '') + '</section>'
        + supervisorHtml
        + '<section class="board-section"><div class="board-section-head"><strong>Workgroups</strong><span class="pill">' + workgroups.size + ' groups</span></div>' + workgroupHtml + '</section>';
      for (const button of board.querySelectorAll("[data-seat-id]")) {
        button.addEventListener("click", () => {
          selectedSeatID = button.getAttribute("data-seat-id");
          renderTeamBoard(currentData);
          renderInspector(currentData);
        });
      }
    }

    function renderMetrics(data) {
      const decision = data.report.decision;
      document.getElementById("repo-pill").textContent = data.repository ? data.repository.repoRoot : "No git repository";
      document.getElementById("refresh-pill").textContent = "Updated " + new Date(data.generatedAt).toLocaleTimeString();
      const seats = seatDefs(data);
      const counts = statusCounts(data, seats);
      const workgroupCount = new Set(seats.map((seat) => seat.workgroupID).filter(Boolean)).size;
      document.getElementById("metrics").innerHTML =
        '<div class="decision-card"><span class="muted">Decision</span><strong class="' + (colors[decision.status] ?? "") + '">' + safe(decision.status) + '</strong><p>' + safe(decision.reason) + '</p></div>'
        + '<div class="metric-group"><h3>Team</h3>' + [
          metric("Model", safe(data.teamManifest?.teamModel ?? "none")),
          metric("Allocation", safe(data.teamManifest?.seatAllocation ?? "none")),
          metric("Phase", safe(data.teamPhase ? data.teamPhase.phase + "/" + data.teamPhase.status : "none")),
          metric("Workgroups", workgroupCount),
          metric("Seats", seats.length),
        ].join("") + '</div>'
        + '<div class="metric-group"><h3>Runtime Mapping</h3>' + [
          metric("Default runtime agent", safe(data.teamManifest?.defaultRuntimeAgent ?? "none")),
          metric("Max parallel seats", safe(data.teamManifest?.maxParallelSeats ?? "n/a")),
          metric("Planning seats", seats.filter((seat) => seat.phase === "planning").length),
          metric("Execution seats", seats.filter((seat) => seat.phase === "execution").length),
          metric("Review seats", seats.filter((seat) => seat.phase === "review").length),
        ].join("") + '</div>'
        + '<div class="metric-group"><h3>Seat State</h3>' + [
          metric("Running", counts.running),
          metric("Waiting", counts.waiting),
          metric("Blocked", counts.blocked),
          metric("Done", counts.done),
          metric("Standby", counts.standby),
        ].join("") + '</div>'
        + '<div class="metric-group"><h3>Records</h3>' + [
          metric("Commons", data.report.commons.messageCount),
          metric("Targeted", data.report.commons.targetedMessages),
          metric("Referenced", data.report.commons.referencedMessages),
          metric("Native git", data.report.nativeGit.recordCount),
        ].join("") + '</div>'
        + '<div class="metric-group"><h3>Governance</h3>' + [
          metric("Pending dispatches", data.report.schedulerQueue?.pending ?? 0),
          metric("Queued records", data.report.schedulerQueue?.queued ?? 0),
          metric("Dispatched tasks", data.report.schedulerQueue?.dispatched ?? 0),
          metric("Contracts", data.report.contractTraceability?.contractCount ?? 0),
          metric("Contract warnings", data.report.contractTraceability?.warningCount ?? 0),
        ].join("") + '</div>';
    }

    function renderInspector(data) {
      const inspector = document.getElementById("seat-inspector");
      const seats = seatDefs(data);
      if (!selectedSeatID && seats.length > 0) {
        const activeSeat = seats.find((seat) => ["blocked","waiting","running"].includes(seatStatus(data, seat))) ?? seats[0];
        selectedSeatID = activeSeat.seatID;
      }
      const seat = seats.find((candidate) => candidate.seatID === selectedSeatID);
      if (!seat) {
        inspector.innerHTML = '<h2>Seat Inspector</h2><div class="empty">Click a seat to inspect status, inbox, and interaction completion.</div>';
        return;
      }
      const state = seatStateByID(data).get(seat.seatID);
      const related = messagesForSeat(data, seat.seatID).sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")));
      const completion = completionForSeat(data, seat.seatID);
      const contracts = contractsForSeat(data, seat);
      const queueRecords = schedulerRecordsForSeat(data, seat.seatID).sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")));
      inspector.innerHTML = '<h2>Seat Inspector</h2>'
        + '<div class="inspector-title"><strong>' + safe(seat.seatID) + '</strong><span class="' + statusClass(state?.status ?? "standby") + '">' + safe(state?.status ?? "standby") + '</span><p class="muted">' + safe(seat.role) + '</p></div>'
        + detailBlock("Seat Definition", '<p>' + safe(seat.reason ?? "No allocation reason recorded.") + '</p>', seat)
        + detailBlock("Current State", '<p>' + safe(state?.memory ?? "No live state memory recorded.") + '</p>', state ?? null)
        + '<div>' + [
          metric("Phase", safe(state?.phase ?? seat.phase ?? "none")),
          metric("Workgroup", safe(state?.workgroupID ?? seat.workgroupID ?? "none")),
          metric("Module", safe(state?.module ?? seat.module ?? "none")),
          metric("Runtime agent", safe(state?.runtimeAgent ?? seat.runtimeAgent ?? "none")),
          metric("Conceptual agent", safe(state?.conceptualAgent ?? seat.conceptualAgent ?? "none")),
          metric("Waiting on", safe((state?.waitingOn ?? []).join(", ") || "none")),
          metric("Task", safe(state?.taskID ?? seat.taskID ?? "none")),
        ].join("") + '</div>'
        + '<div><h3>Interaction Completion</h3><div class="progress"><div style="width:' + completion.percent + '%"></div></div><p class="muted">' + completion.done + ' / ' + completion.total + ' question threads completed. Authored questions: ' + completion.authoredQuestions + '. Inbound questions: ' + completion.inboundQuestions + '.</p></div>'
        + '<div><h3>Scheduler Queue</h3><div class="inspector-list">' + (queueRecords.length ? queueRecords.slice(0, 8).map(renderQueueDetails).join("") : '<div class="empty">No queued or dispatched scheduler work for this seat.</div>') + '</div></div>'
        + '<div><h3>Contract Traceability</h3><div class="inspector-list">' + (contracts.length ? contracts.map(renderContractDetails).join("") : '<div class="empty">No contract linked to this seat yet.</div>') + '</div></div>'
        + '<div><h3>Recent Seat Interactions</h3><div class="inspector-list">' + (related.length ? related.slice(0, 10).map(renderMessageDetails).join("") : '<div class="empty">No direct interactions for this seat yet.</div>') + '</div></div>';
    }

    function renderTimeline(data) {
      const timeline = document.getElementById("timeline");
      if (!timeline) return;
      const messages = [...(data.commonsMessages ?? [])].sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))).slice(-30).reverse();
      timeline.innerHTML = messages.length
        ? messages.map(renderMessageDetails).join("")
        : '<div class="empty">No commons messages yet.</div>';
    }

    async function render() {
      const data = await loadData();
      currentData = data;
      renderMetrics(data);
      renderTeamBoard(data);
      renderInspector(data);
      renderTimeline(data);
    }

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

  const server = Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/data.json") {
        return Response.json(buildRepublicDashboardData(options))
      }
      return new Response(
        renderRepublicDashboardHtml(buildRepublicDashboardData(options), {
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
