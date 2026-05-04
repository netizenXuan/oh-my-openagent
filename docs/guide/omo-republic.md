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
    "git_summary": true
  }
}
```

The current implementation is advisory. It records, summarizes, and recommends. Strong enforcement, per-seat worktrees, and automatic execution gates belong in later governed mode work.

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
