# OMO Republic

OMO Republic is a deliberative workflow layer for complex agent work. It is designed for projects where a single main agent feels too thin and where every meaningful change should have a durable Git-centered audit trail.

## Design

OMO Republic borrows from United States institutional design as an engineering pattern:

- **House of Planners**: several same-role planner seats generate independent first-pass plans.
- **Senate of Planners**: several same-role planner seats review long-term stability, compatibility, and review burden.
- **Conference Committee**: one synthesis phase reconciles conflicts between seats.
- **Review Bench**: reviewer seats can flag blockers, rollback risk, and missing tests before execution.

The important idea is not "more expert titles." The idea is multiple independent seats for the same role. That gives the system diversity without turning the workflow into a loose pile of specialists.

## Git-Centered Records

OMO Republic writes deliberation records under the Git common dir:

```text
.git/omo/republic/ledger.jsonl
.git/omo/republic/commons.jsonl
.git/omo/republic/agents/<seat-id>.md
.git/omo/republic/contracts/<workgroup-id>.md
.git/omo/republic/deliberations/<deliberation-id>/
```

Native Git tracking writes tool-caused file changes separately:

```text
.git/omo/native-git/audit.jsonl
```

Because both locations are inside `.git`, neither the deliberation ledger nor native-git audit records dirty the worktree.

## Republic Commons

The ledger records durable votes and phase summaries. The commons records the conversation between seats.

This matters because parallel agents are otherwise isolated workers: the main agent asks questions, waits for answers, and manually reconciles them. Republic Commons adds an asynchronous shared board where seats can publish proposals, ask targeted questions, object to another seat, answer objections, revise their position, and record consensus. The result is closer to a real committee hearing than a batch of unrelated subtask reports.

Commons messages are JSONL records with a `deliberationID`, `channel`, `phase`, `round`, `authorSeatID`, `messageType`, optional `targetSeatID`, optional `references`, touched `files`, and concise `content`.

Each Commons message is also mirrored into per-seat Markdown docs when agent docs are enabled:

```text
.git/omo/republic/agents/api-seat.md
.git/omo/republic/agents/docs-seat.md
```

The author doc receives every message the seat publishes. The target doc receives directed messages. These docs make each seat's durable working memory readable by later turns without dirtying the worktree.

Native Git tracking now auto-publishes tool-caused changes into Commons as `messageType: "status"` and mirrors them into the ledger. A write/edit/bash/apply_patch call that changes Git state therefore creates both:

- `.git/omo/native-git/audit.jsonl`: the raw file-change audit
- `.git/omo/republic/commons.jsonl`: the collaboration event visible to other seats and the dashboard

For large engineering projects, Commons and ledger records can also carry organization fields:

- `workgroupID`: a module workgroup such as `api-workgroup` or `ui-workgroup`
- `module`: the module being owned or discussed
- `taskID`: a concrete module task
- `dependsOn`: task IDs that this seat depends on
- `supervisorSeatID`: the coordinating seat that may interrupt or correct drift
- `status`: `planned`, `in-progress`, `blocked`, `review`, or `done`

The expected deliberation rhythm is:

1. Round 0: independent proposals. Seats do not read each other first.
2. Round 1: cross-examination. Each seat reads the commons and responds to at least one other message by ID.
3. Round 2: revision or consensus. Seats update their position, preserve dissent, or confirm agreement.
4. Conference report: the synthesizer reads both `ledger.jsonl` and `commons.jsonl`.

## Interactive Commons

OMO Republic now supports agent-to-agent collaboration through three built-in tools:

- `republic_publish`: publish a `question`, `answer`, `objection`, `proposal`, `revision`, `handoff`, `consensus`, or `note`.
- `republic_inbox`: read messages relevant to the current or named seat, optionally including the seat Markdown doc.
- `republic_contract`: write or revise a workgroup contract before adjacent modules implement against each other.

This supports the intended workflow:

1. `api-seat` is unsure about an interface and publishes a targeted `question` to `docs-seat`.
2. The Republic scheduler immediately launches a background seat session for `docs-seat` when `scheduler.auto_dispatch` is enabled.
3. `docs-seat` reads `republic_inbox`, replies with `answer`, and references the original message ID.
4. If a seat publishes an `objection`, that objection can dispatch another target seat and the supervisor policy loop treats unresolved objections as governance items.
5. On the next agent turn, relevant inbox messages are injected into the prompt inside `<republic-commons-inbox>`.
6. The affected seats answer, revise, hand off, or write a `republic_contract`.

This is still not a live mid-token chat bus. It is now an active Git-native scheduler: targeted Commons messages create background response sessions, all coordination is stored under `.git/omo/republic`, and OMO injects relevant messages before the next turn.

## Workgroup Contracts

Adjacent module agents should declare a contract before implementation when their work touches shared API shape, data schema, test boundary, error semantics, or handoff responsibility.

`republic_contract` writes the contract under:

```text
.git/omo/republic/contracts/<workgroup-id>.md
```

It also publishes a `messageType: "contract"` Commons record and mirrors it into agent docs. The dashboard and status tooling can then connect the contract to seats, files, workgroups, and later implementation changes.

## Governed Execution Hooks

Republic execution has three live governance hooks:

- **Automatic Commons publication**: native-git changes are published to Commons with agent, model, session, call, files, module, workgroup, and task metadata.
- **Supervisor intervention**: high-risk file paths, large change sets, role-boundary crossings, or edits outside explicit user-mentioned paths create `messageType: "intervention"` records from `republic-supervisor` and append a visible system reminder to the tool output.
- **Workgroup dependency gate**: before explicit multi-file tools run, OMO infers touched modules. If a call crosses the configured module threshold, advisory mode records a `dependency-blocked` preflight message and warns; governed block mode records the same message and blocks the tool call.
- **Active Republic scheduler**: targeted `question`, `handoff`, and `objection` messages launch background response sessions for the target seat. Dispatch records are written back to Commons and ledger with `channel: "scheduler"`.
- **Supervisor policy loop**: on idle, OMO scans Commons for unresolved questions, unresolved objections, dependency blocks, and supervisor interventions, then records a `supervisor-policy` message that tells affected seats to read inbox and respond before continuing.
- **Agent prompt injection**: before a new chat turn, OMO reads the current seat's relevant Commons inbox and injects a compact `<republic-commons-inbox>` block into context.

These hooks still do not auto-commit, auto-stash, or create worktrees. Git history remains under user or `git-master` control.

## Commands

Start a deliberation:

```text
/deliberate <problem-or-plan>
```

Summarize the deliberation and Git audit state in OpenCode:

```text
/republic-status [deliberation-id]
```

Summarize from the CLI:

```bash
bunx oh-my-opencode republic status --directory /path/to/repo
bunx oh-my-opencode republic status --directory /path/to/repo --json
```

Render a static collaboration graph dashboard:

```bash
bunx oh-my-opencode republic dashboard --directory /path/to/repo
```

Serve a live dashboard that polls the Git common-dir records:

```bash
bunx oh-my-opencode republic dashboard --directory /path/to/repo --serve --port 4097
```

Open the dashboard from OpenCode:

```text
/republic-dashboard [deliberation-id] [--serve] [--port=4097]
```

The status report includes a governance decision:

- `no-records`: no Republic ledger exists yet.
- `needs-quorum`: not enough independent seat records exist.
- `blocked`: at least one reject/blocker vote is present and blocker veto is enabled.
- `approved`: approve votes meet the configured supermajority.
- `revise`: the plan should be revised before execution.

It also includes a Commons section with message counts, channels, phases, authors, agents, message types, targeted messages, referenced messages, and files discussed.

## Dashboard

The Republic dashboard converts Git-native records into a network graph:

- repository, deliberation, chamber, workgroup, seat, agent, task, message, module, file, tool, and decision nodes
- `runs`, `published`, `targets`, `references`, `coordinates`, `assigns`, `supervises`, `depends-on`, `discusses`, `reviews`, and `changed` edges
- a Commons timeline showing recent cross-seat proposals, questions, objections, revisions, and consensus

By default the static HTML is written under:

```text
.git/omo/republic/dashboard.html
```

The dashboard is intentionally data-first. The graph model is suitable for a future draggable editor where users can define custom agent teams, module workgroups, supervisors, and communication lanes visually.

## OpenCode Smoke Verification

The current implementation has been smoke tested through the real OpenCode CLI with a local plugin path and `kimi-for-coding/k2p6`:

- `Hephaestus - Deep Agent`: allowed on Kimi K2.x and recorded `agent="hephaestus"` plus `model="kimi-for-coding/k2p6"` in `.git/omo/native-git/audit.jsonl`.
- `Sisyphus - Ultraworker`: wrote scoped coordination files and recorded `agent="sisyphus"` plus the Kimi model.
- `Prometheus - Plan Builder`: correctly enforced the planning-agent boundary by refusing writes outside `.sisyphus/`, then wrote `.sisyphus/plans/prometheus-smoke-test.md` with native-git attribution.
- `Atlas - Plan Executor`: wrote smoke output, triggered the existing orchestrator warning for direct file edits, and still recorded native-git attribution.

The same smoke repository rendered `republic status` and `republic dashboard` from the generated Git common-dir records. The status summary reported all four primary agents, seven native-git write records, and one Kimi K2.6 model bucket.

## Governance Smoke Verification

A second realistic smoke test used a small TypeScript order service with API, domain, config, docs, and test modules. The project was opened through the real OpenCode CLI with a local plugin path and `kimi-for-coding/k2p6`.

Verified behavior:

- Automatic Commons publication mirrored Kimi tool changes from `.git/omo/native-git/audit.jsonl` into `.git/omo/republic/commons.jsonl`.
- Sequential edits across `src/api`, `docs/api`, and `tests` produced post-change dependency-gate records with `phase: "post-change"` and `status: "review-required"`.
- High-risk edits to `package.json` and `src/config/runtime.ts` produced supervisor intervention records and visible tool-output reminders.
- The smoke project test suite continued to pass after each committed Kimi task.

Observed model behavior:

- Kimi K2.6 reliably produced real file edits and the plugin tracked them with `agent` and `model` attribution.
- Kimi K2.6 did not reliably obey a prompt that required a specific Shell tool call. In that case, the plugin still recorded the actual write, and supervisor path-drift detection can now flag edits outside paths explicitly named by the user. A preflight block can only evaluate the tool call the model actually attempts.

That distinction is intentional for the first governed implementation: preflight gates block explicit cross-workgroup tool calls, while post-change gates catch cumulative multi-module edits that happen through several single-file tool calls.

## Interactive Commons Smoke Verification

The same OpenCode CLI plus local plugin path setup has also verified the interactive Commons layer with `kimi-for-coding/k2p6`:

- `api-seat` published a targeted `question` to `docs-seat` with `republic_publish`.
- `docs-seat` read the message and the supervisor note with `republic_inbox`, then replied with an `answer` referencing the original message ID.
- `api-seat` wrote an accepted `republic_contract` for the shared `cancelOrder` response shape.
- The contract was stored at `.git/omo/republic/contracts/wg-order-api.md` and also published to Commons.
- Agent docs were updated at `.git/omo/republic/agents/api-seat.md` and `.git/omo/republic/agents/docs-seat.md`.
- A separate custom-deliberation question verified that the supervisor policy loop scans Commons across deliberation IDs and records `supervisor-policy` when a question remains unresolved.
- `republic status --json` and `republic dashboard --json` reported the `question`, `answer`, `contract`, and `supervisor-policy` records, and the smoke repository worktree stayed clean.

The smoke run exposed one real integration bug: Republic tools initially used only the plugin initialization directory to resolve Git state, which can be absent in OpenCode tool context. The tools now resolve the repository from tool context (`directory`, `worktree`, `path.cwd`, `path.root`) before falling back to plugin input.

## Configuration

```jsonc
{
  "republic": {
    "enabled": true,
    "mode": "advisory",
    "ledger": true,
    "house_seats": 3,
    "senate_seats": 2,
    "review_bench_seats": 2,
    "quorum": 4,
    "supermajority": 0.67,
    "veto_on_blocker": true,
    "git_summary": true,
    "commons": {
      "auto_publish": true,
      "inbox": true,
      "inject_max_messages": 6,
      "agent_docs": true
    },
    "supervisor": {
      "intervention": true,
      "policy_loop": true,
      "file_threshold": 5,
      "high_risk_paths": [
        "package.json",
        "bun.lock",
        "src/config/",
        "src/plugin/",
        "src/shared/git-worktree/",
        ".github/workflows/"
      ]
    },
    "dependency_gate": {
      "enabled": true,
      "mode": "advisory",
      "cross_module_threshold": 2
    },
    "contracts": {
      "enabled": true
    },
    "scheduler": {
      "enabled": true,
      "auto_dispatch": true,
      "message_types": ["question", "handoff", "objection"],
      "default_agent": "sisyphus",
      "supervisor_agent": "hephaestus",
      "seat_agents": {
        "api-seat": "atlas",
        "docs-seat": "hephaestus"
      },
      "prompt_max_messages": 8
    }
  }
}
```

Modes:

- `manual`: Republic governance is off.
- `advisory`: default; record Commons/ledger events and show warnings, but do not block writes.
- `governed`: enables stronger gates. The first implemented hard gate is `dependency_gate.mode: "block"` for cross-workgroup explicit write tools.

`scheduler.seat_agents` maps conceptual seats to concrete OMO agents. If no mapping exists, OMO infers common agent names from the target seat ID, uses `scheduler.supervisor_agent` for supervisor seats, and falls back to `scheduler.default_agent`.

Per-seat worktrees, automatic merge orchestration, and true live agent-to-agent streaming remain future work.

For the larger engineering-organization design, see [OMO Republic Engineering Organization](../architecture/republic-engineering-organization.md).

## Operating Model

Use OMO Republic when the task has high review cost, unclear architecture tradeoffs, or a high chance of hidden coupling. For routine edits, use the normal agent flow and native-git audit.

A typical session:

1. Run `/deliberate "Should we migrate the API client to a shared retry layer?"`.
2. Let the House and Senate seats produce independent proposals.
3. Read the conference report and review bench blockers.
4. Run `/republic-status` to verify ledger and native-git audit state.
5. Execute the accepted plan.
6. Use `git-master` to make atomic commits.
