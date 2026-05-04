import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  getNativeGitRepository,
  readNativeGitAuditRecords,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  sanitizeRepublicDeliberationID,
  type NativeGitAuditRecord,
  type NativeGitRepository,
  type RepublicCommonsMessage,
  type RepublicLedgerRecord,
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
    | "chamber"
    | "seat"
    | "agent"
    | "message"
    | "module"
    | "file"
    | "tool"
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
        addFileNodes(nodes, edges, seatID, record.files, "reviews")
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

      addFileNodes(nodes, edges, messageNodeID, message.files, "discusses")
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
    :root { color-scheme: dark; --bg:#0d1117; --panel:#151b23; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --green:#3fb950; --red:#f85149; --yellow:#d29922; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    header { height:56px; display:flex; align-items:center; justify-content:space-between; padding:0 20px; border-bottom:1px solid var(--line); background:#010409; }
    main { display:grid; grid-template-columns: 320px 1fr 360px; height:calc(100vh - 56px); min-height:680px; }
    aside { border-right:1px solid var(--line); background:var(--panel); overflow:auto; }
    section { overflow:auto; }
    .right { border-left:1px solid var(--line); border-right:0; }
    .pad { padding:18px; }
    h1 { margin:0; font-size:17px; letter-spacing:0; }
    h2 { margin:0 0 12px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:0; }
    .metric { display:flex; justify-content:space-between; gap:16px; padding:9px 0; border-bottom:1px solid rgba(48,54,61,.7); }
    .metric span:first-child { color:var(--muted); }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:3px 9px; color:var(--muted); font-size:12px; }
    .graph-wrap { height:100%; min-height:680px; padding:16px; }
    svg { width:100%; height:100%; min-height:640px; background:#0d1117; border:1px solid var(--line); border-radius:8px; }
    .edge { stroke:#546170; stroke-width:1.2; opacity:.75; }
    .edge-label { fill:var(--muted); font-size:10px; }
    .node rect { rx:7; ry:7; stroke:var(--line); stroke-width:1.1; }
    .node text { fill:var(--text); font-size:12px; pointer-events:none; }
    .node .sub { fill:var(--muted); font-size:10px; }
    .repository rect { fill:#10233d; }
    .deliberation rect { fill:#152d25; }
    .chamber rect { fill:#292b15; }
    .seat rect { fill:#271f3a; }
    .agent rect { fill:#1f2937; }
    .message rect { fill:#2b1d22; }
    .module rect { fill:#132f32; }
    .file rect { fill:#172033; }
    .tool rect { fill:#2b2416; }
    .decision rect { fill:#281b30; }
    .timeline { display:flex; flex-direction:column; gap:10px; }
    .item { border:1px solid var(--line); border-radius:8px; padding:10px; background:#0d1117; }
    .item strong { display:block; margin-bottom:4px; }
    .item p { margin:0; color:var(--muted); }
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
    <section class="graph-wrap">
      <svg id="graph" role="img" aria-label="OMO Republic agent collaboration graph"></svg>
    </section>
    <aside class="pad right">
      <h2>Commons Timeline</h2>
      <div id="timeline" class="timeline"></div>
    </aside>
  </main>
  <script>
    const typeOrder = ["repository","deliberation","chamber","seat","agent","message","module","file","tool","decision"];
    const colors = { approved:"status-approved", blocked:"status-blocked", "needs-quorum":"status-needs-quorum", revise:"status-revise" };
    ${liveLoader}

    function metric(label, value) {
      return '<div class="metric"><span>' + label + '</span><strong>' + value + '</strong></div>';
    }

    function safe(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    }

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

    function renderMetrics(data) {
      const decision = data.report.decision;
      document.getElementById("repo-pill").textContent = data.repository ? data.repository.repoRoot : "No git repository";
      document.getElementById("refresh-pill").textContent = "Updated " + new Date(data.generatedAt).toLocaleTimeString();
      document.getElementById("metrics").innerHTML = [
        metric("Decision", '<span class="' + (colors[decision.status] ?? "") + '">' + safe(decision.status) + '</span>'),
        metric("Ledger records", data.report.republic.recordCount),
        metric("Commons messages", data.report.commons.messageCount),
        metric("Native git records", data.report.nativeGit.recordCount),
        metric("Nodes", data.nodes.length),
        metric("Edges", data.edges.length),
        metric("Targeted messages", data.report.commons.targetedMessages),
        metric("Referenced messages", data.report.commons.referencedMessages),
        metric("Reason", safe(decision.reason))
      ].join("");
    }

    function renderTimeline(data) {
      const messages = [...data.commonsMessages].sort((left, right) => String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""))).slice(-30).reverse();
      document.getElementById("timeline").innerHTML = messages.length
        ? messages.map((message) => '<div class="item"><strong>' + safe(message.authorSeatID) + ' · ' + safe(message.messageType) + '</strong><p>' + safe(message.content) + '</p><p class="muted">' + safe(message.channel) + ' / round ' + safe(message.round ?? "n/a") + '</p></div>').join("")
        : '<p class="muted">No commons messages yet.</p>';
    }

    async function render() {
      const data = await loadData();
      renderMetrics(data);
      renderGraph(data);
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
