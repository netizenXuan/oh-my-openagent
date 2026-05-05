import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  getNativeGitRepository,
  readNativeGitAuditRecords,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  readRepublicSeatState,
  readRepublicTeamManifest,
  readRepublicTeamPhase,
  sanitizeRepublicDeliberationID,
  type NativeGitAuditRecord,
  type NativeGitRepository,
  type RepublicCommonsMessage,
  type RepublicLedgerRecord,
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
    nativeGitRecords,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values()),
  }
}

function defaultDashboardPath(repository: NativeGitRepository, output?: string): string {
  return output ? resolve(output) : join(repository.gitCommonDir, "omo", "republic", "dashboard.html")
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
    :root { color-scheme: dark; --bg:#0d1117; --panel:#151b23; --panel2:#0f141b; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --green:#3fb950; --red:#f85149; --yellow:#d29922; --purple:#a371f7; --cyan:#39c5cf; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    header { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 20px; border-bottom:1px solid var(--line); background:#010409; }
    main { display:grid; grid-template-columns: 300px 1fr 420px; height:calc(100vh - 56px); min-height:700px; }
    aside { border-right:1px solid var(--line); background:var(--panel); overflow:auto; }
    section { overflow:auto; }
    .right { border-left:1px solid var(--line); border-right:0; }
    .pad { padding:18px; }
    h1 { margin:0; font-size:17px; letter-spacing:0; }
    h2 { margin:0 0 12px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0; }
    h3 { margin:0 0 10px; font-size:14px; }
    .metric { display:flex; justify-content:space-between; gap:16px; padding:9px 0; border-bottom:1px solid rgba(48,54,61,.7); }
    .metric span:first-child { color:var(--muted); }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:3px 9px; color:var(--muted); font-size:12px; }
    .board-wrap { height:100%; min-height:700px; padding:16px; overflow:auto; }
    .board { min-width:880px; display:flex; flex-direction:column; gap:14px; }
    .phase-strip { display:grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap:12px; }
    .phase-card { border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--panel2); min-height:88px; }
    .phase-card.active { border-color:var(--accent); box-shadow:0 0 0 1px rgba(47,129,247,.25) inset; }
    .phase-title { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
    .phase-title strong { font-size:13px; text-transform:uppercase; }
    .phase-title span { color:var(--muted); font-size:12px; }
    .workgroup-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:14px; }
    .workgroup-card { border:1px solid var(--line); border-radius:8px; background:var(--panel2); overflow:hidden; }
    .workgroup-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--line); background:#111822; }
    .workgroup-head strong { font-size:14px; }
    .seat-list { display:flex; flex-direction:column; gap:8px; padding:12px; }
    .seat-card { width:100%; text-align:left; border:1px solid var(--line); border-radius:8px; padding:10px; background:#0d1117; color:var(--text); cursor:pointer; transition:border-color .12s ease, background .12s ease; }
    .seat-card:hover, .seat-card.selected { border-color:var(--accent); background:#101a28; }
    .seat-top { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:5px; }
    .seat-name { font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .seat-meta { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .status { display:inline-flex; border-radius:999px; padding:2px 8px; font-size:11px; border:1px solid var(--line); color:var(--muted); }
    .status-running { color:var(--cyan); border-color:rgba(57,197,207,.45); }
    .status-waiting { color:var(--yellow); border-color:rgba(210,153,34,.45); }
    .status-blocked, .status-error { color:var(--red); border-color:rgba(248,81,73,.45); }
    .status-done { color:var(--green); border-color:rgba(63,185,80,.45); }
    .status-standby { color:var(--muted); }
    .supervisor-zone { border:1px solid rgba(163,113,247,.45); border-radius:8px; padding:12px; background:#151222; }
    .supervisor-zone .seat-card { border-color:rgba(163,113,247,.35); }
    .timeline, .inspector-list { display:flex; flex-direction:column; gap:10px; }
    .item { border:1px solid var(--line); border-radius:8px; padding:10px; background:#0d1117; }
    .item strong { display:block; margin-bottom:4px; }
    .item p { margin:0; color:var(--muted); }
    .item small { color:var(--muted); }
    .inspector { display:flex; flex-direction:column; gap:16px; }
    .inspector-title { border:1px solid var(--line); border-radius:8px; padding:12px; background:#0d1117; }
    .inspector-title strong { display:block; font-size:16px; margin-bottom:4px; }
    .progress { height:8px; border-radius:999px; overflow:hidden; background:#1f2937; }
    .progress div { height:100%; background:var(--green); width:0; }
    .empty { border:1px dashed var(--line); border-radius:8px; padding:14px; color:var(--muted); background:#0d1117; }
    .muted { color:var(--muted); }
    .status-approved { color:var(--green); }
    .status-blocked { color:var(--red); }
    .status-needs-quorum, .status-revise { color:var(--yellow); }
  </style>
</head>
<body>
  <script type="application/json" id="republic-data">${initialData}</script>
  <header>
    <h1>OMO Republic Dashboard</h1>
    <div><span id="repo-pill" class="pill"></span> <span id="refresh-pill" class="pill"></span></div>
  </header>
  <main>
    <aside class="pad">
      <h2>Execution State</h2>
      <div id="metrics"></div>
    </aside>
    <section class="board-wrap">
      <div id="team-board" class="board" aria-label="OMO Republic team board"></div>
    </section>
    <aside class="pad right">
      <div id="seat-inspector" class="inspector"></div>
    </aside>
  </main>
  <script>
    const typeOrder = ["repository","deliberation","phase","chamber","workgroup","seat","agent","task","message","module","file","tool","decision"];
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

    /* Legacy all-edge graph renderer is disabled. The dashboard now renders a
       simplified team board and keeps dense relationship data in JSON only.
    function layoutNodes(nodes) {
      const byType = new Map();
      for (const node of nodes) {
        const type = typeOrder.includes(node.type) ? node.type : "message";
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(node);
      }
      const width = Math.max(1160, typeOrder.length * 145);
      const positions = new Map();
      for (const [typeIndex, type] of typeOrder.entries()) {
        const group = byType.get(type) ?? [];
        const x = 76 + typeIndex * 138;
        group.forEach((node, index) => {
          positions.set(node.id, { x, y: 70 + index * 82, width: 118, height: 48 });
        });
      }
      const height = Math.max(640, Math.max(1, ...Array.from(byType.values()).map((group) => group.length)) * 82 + 120);
      return { positions, width, height };
    }

    function renderGraph(data) {
      const svg = document.getElementById("graph");
      const { positions, width, height } = layoutNodes(data.nodes);
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.innerHTML = '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#546170"></path></marker></defs>';

      for (const edge of data.edges) {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) continue;
        const x1 = source.x + source.width;
        const y1 = source.y + source.height / 2;
        const x2 = target.x;
        const y2 = target.y + target.height / 2;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("class", "edge");
        line.setAttribute("marker-end", "url(#arrow)");
        svg.appendChild(line);
        if (edge.label) {
          const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
          text.setAttribute("x", (x1 + x2) / 2);
          text.setAttribute("y", (y1 + y2) / 2 - 4);
          text.setAttribute("class", "edge-label");
          text.textContent = edge.label;
          svg.appendChild(text);
        }
      }

      for (const node of data.nodes) {
        const position = positions.get(node.id);
        if (!position) continue;
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("class", "node " + node.type);
        group.setAttribute("transform", "translate(" + position.x + "," + position.y + ")");
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("width", position.width);
        rect.setAttribute("height", position.height);
        group.appendChild(rect);
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", 10);
        label.setAttribute("y", 20);
        label.textContent = node.label.length > 18 ? node.label.slice(0, 17) + "…" : node.label;
        group.appendChild(label);
        const sub = document.createElementNS("http://www.w3.org/2000/svg", "text");
        sub.setAttribute("x", 10);
        sub.setAttribute("y", 38);
        sub.setAttribute("class", "sub");
        sub.textContent = node.type;
        group.appendChild(sub);
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = [node.label, node.detail].filter(Boolean).join("\\n");
        group.appendChild(title);
        svg.appendChild(group);
      }
    }

    */

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

    function renderSeatCard(data, seat) {
      const state = seatStateByID(data).get(seat.seatID);
      const status = state?.status ?? "standby";
      const selected = selectedSeatID === seat.seatID ? " selected" : "";
      return '<button class="seat-card' + selected + '" data-seat-id="' + safe(seat.seatID) + '">'
        + '<div class="seat-top"><span class="seat-name">' + safe(seat.seatID) + '</span><span class="' + statusClass(status) + '">' + safe(status) + '</span></div>'
        + '<div class="seat-meta">' + safe(seat.role) + (seat.module ? ' / ' + safe(seat.module) : '') + '</div>'
        + '</button>';
    }

    function renderPhaseStrip(data) {
      const activePhase = data.teamPhase?.phase ?? "idle";
      const phases = ["planning", "execution", "review", "idle"];
      return '<div class="phase-strip">' + phases.map((phase) => {
        const count = seatDefs(data).filter((seat) => seat.phase === phase || (phase === "idle" && seat.role === "supervisor")).length;
        const active = phase === activePhase ? " active" : "";
        return '<div class="phase-card' + active + '"><div class="phase-title"><strong>' + safe(phase) + '</strong><span>' + count + ' seats</span></div><div class="muted">' + safe(phase === activePhase ? (data.teamPhase?.status ?? "active") : "standby") + '</div></div>';
      }).join("") + '</div>';
    }

    function renderTeamBoard(data) {
      const seats = seatDefs(data);
      const supervisors = seats.filter((seat) => seat.role === "supervisor");
      const workerSeats = seats.filter((seat) => seat.role !== "supervisor");
      const workgroups = new Map();
      for (const seat of workerSeats) {
        const key = seat.workgroupID ?? "unassigned";
        if (!workgroups.has(key)) workgroups.set(key, []);
        workgroups.get(key).push(seat);
      }
      const board = document.getElementById("team-board");
      if (seats.length === 0) {
        board.innerHTML = '<div class="empty">No persistent Republic team has been initialized yet.</div>';
        return;
      }
      const supervisorHtml = supervisors.length
        ? '<div class="supervisor-zone"><h3>Supervisor</h3><div class="seat-list">' + supervisors.map((seat) => renderSeatCard(data, seat)).join("") + '</div></div>'
        : "";
      const workgroupHtml = '<div class="workgroup-grid">' + Array.from(workgroups.entries()).map(([workgroupID, group]) => {
        const running = group.filter((seat) => seatStatus(data, seat) === "running").length;
        const waiting = group.filter((seat) => seatStatus(data, seat) === "waiting").length;
        return '<div class="workgroup-card"><div class="workgroup-head"><strong>' + safe(workgroupID) + '</strong><span class="pill">' + running + ' running / ' + waiting + ' waiting</span></div><div class="seat-list">' + group.map((seat) => renderSeatCard(data, seat)).join("") + '</div></div>';
      }).join("") + '</div>';
      board.innerHTML = renderPhaseStrip(data) + supervisorHtml + workgroupHtml;
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
      const states = seatStateByID(data);
      const statusCount = (status) => seats.filter((seat) => (states.get(seat.seatID)?.status ?? "standby") === status).length;
      const workgroupCount = new Set(seats.map((seat) => seat.workgroupID).filter(Boolean)).size;
      document.getElementById("metrics").innerHTML = [
        metric("Decision", '<span class="' + (colors[decision.status] ?? "") + '">' + safe(decision.status) + '</span>'),
        metric("Team model", safe(data.teamManifest?.teamModel ?? "none")),
        metric("Team phase", safe(data.teamPhase ? data.teamPhase.phase + "/" + data.teamPhase.status : "none")),
        metric("Workgroups", workgroupCount),
        metric("Seats", seats.length),
        metric("Running", statusCount("running")),
        metric("Waiting", statusCount("waiting")),
        metric("Blocked", statusCount("blocked") + statusCount("error")),
        metric("Done", statusCount("done")),
        metric("Commons messages", data.report.commons.messageCount),
        metric("Native git records", data.report.nativeGit.recordCount),
        metric("Targeted messages", data.report.commons.targetedMessages),
        metric("Referenced messages", data.report.commons.referencedMessages),
        metric("Reason", safe(decision.reason))
      ].join("");
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
      inspector.innerHTML = '<h2>Seat Inspector</h2>'
        + '<div class="inspector-title"><strong>' + safe(seat.seatID) + '</strong><span class="' + statusClass(state?.status ?? "standby") + '">' + safe(state?.status ?? "standby") + '</span><p class="muted">' + safe(seat.role) + '</p></div>'
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
        + '<div><h3>Recent Seat Interactions</h3><div class="inspector-list">' + (related.length ? related.slice(0, 10).map((message) => '<div class="item"><strong>' + safe(message.messageType) + (message.targetSeatID ? ' to ' + safe(message.targetSeatID) : '') + '</strong><p>' + safe(message.content) + '</p><small>' + safe(message.channel) + ' / ' + safe(message.phase) + ' / round ' + safe(message.round ?? "n/a") + '</small></div>').join("") : '<div class="empty">No direct interactions for this seat yet.</div>') + '</div></div>';
    }

    function renderTimeline(data) {
      const messages = [...data.commonsMessages].sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))).slice(-30).reverse();
      document.getElementById("timeline").innerHTML = messages.length
        ? messages.map((message) => '<div class="item"><strong>' + safe(message.authorSeatID) + ' · ' + safe(message.messageType) + '</strong><p>' + safe(message.content) + '</p><p class="muted">' + safe(message.channel) + ' / round ' + safe(message.round ?? "n/a") + '</p></div>').join("")
        : '<p class="muted">No commons messages yet.</p>';
    }

    async function render() {
      const data = await loadData();
      currentData = data;
      renderMetrics(data);
      renderTeamBoard(data);
      renderInspector(data);
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

async function serveRepublicDashboard(options: RepublicDashboardOptions): Promise<number> {
  const port = options.port ?? 4097
  const initialData = buildRepublicDashboardData(options)
  if (!initialData.repository) {
    console.error("Not inside a git repository. Cannot serve Republic dashboard.")
    return 1
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

  console.log(`OMO Republic dashboard serving at http://127.0.0.1:${server.port}`)
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
  console.log(`OMO Republic dashboard written to ${outputPath}`)
  return 0
}
