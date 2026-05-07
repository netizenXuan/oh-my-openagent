# OMO Republic Product Brief

OMO Republic is a Git-native multi-seat governance layer for OpenCode and OMO. It is built for complex engineering work where ordinary single-agent execution or loose subagent fan-out is not enough.

## Positioning

Republic is not just "more agents." It is a durable engineering organization model:

- seats are persistent identities with state, memory, inbox, and workgroup ownership
- Commons records proposals, questions, answers, objections, revisions, handoffs, consensus, and supervisor notes
- contracts capture shared API, schema, test, and handoff rules before coupled modules implement against each other
- native-git audit records every tool-caused Git change under the Git common dir
- the supervisor can detect idle phases, dependency gates, unresolved questions, and contract warnings after the chat turn ends
- the dashboard turns the Git common-dir records into an inspectable command board

The design target is auditable weak-model coordination: cheaper models can participate because the system gives them hard fields, labeled context, explicit contracts, scheduler records, and guardrails instead of relying on long prose instructions alone.

## App Entry

OpenCode App exposes Republic as primary agents in the same selector used by the existing OMO roles:

| Agent | Preset | Default capacity | Use when |
| ----- | ------ | ---------------- | -------- |
| `Republic - Team Orchestrator` | Standard | `max_parallel_seats=4` | Normal complex work, balanced cost, default choice |
| `Republic - Large Team` | Large | `max_parallel_seats=8`, larger planner/executor/reviewer benches | Several adjacent modules, heavier review, medium projects |
| `Republic - Extreme Team` | Extreme | `max_parallel_seats=12`, largest default benches | Stress tests, large rewrites, or high-risk projects |

All three agents run the same Republic system. The preset only changes default seat counts passed to `republic_team_init`. The user can still override counts in the prompt or config.

## Workflow

1. The user selects a Republic primary agent or triggers Republic with `repwork` / `republicwork`.
2. The orchestrator reads repository context and current Republic state.
3. If no suitable team exists, it initializes a team with `team_model="parliament_squad"` and dynamic seat allocation.
4. Planning seats publish independent proposals, then read Commons and respond to one another.
5. Coupled modules write workgroup contracts before execution.
6. Execution seats implement assigned modules using the locked contracts and Commons inbox.
7. Review seats inspect implementation, tests, contracts, and native-git changes.
8. Supervisor publishes interventions or final verdicts.
9. The phase is closed only when review is complete or a blocker is recorded.

In `parliament`, `squad`, or `parliament_squad`, Republic is the orchestration layer. It blocks independent legacy `task` / `call_omo_agent` fan-out from the main agent so the project does not split into two unmanaged multi-agent systems.

## Git-Native Records

Republic writes under the Git common dir, so governance records do not dirty the worktree:

```text
.git/omo/republic/ledger.jsonl
.git/omo/republic/commons.jsonl
.git/omo/republic/team/manifest.json
.git/omo/republic/team/phase.json
.git/omo/republic/team/seats/<seat-id>/state.json
.git/omo/republic/team/seats/<seat-id>/memory.md
.git/omo/republic/agents/<seat-id>.md
.git/omo/republic/contracts/<workgroup-id>.md
.git/omo/republic/scheduler/queue.jsonl
.git/omo/native-git/audit.jsonl
```

The working tree stays focused on product code. The Git common dir keeps governance evidence, audit trails, scheduler records, and seat memory.

## Dashboard

`oh-my-opencode republic dashboard --serve` starts a local live dashboard. In the App workflow, `republic.dashboard.auto_open` opens it by default when a team starts.

The dashboard shows:

- governance decision and phase
- seat counts and active workload
- phase lanes for planning, execution, review, and idle
- workgroup lanes with seat cards
- per-seat inspector with state, inbox, contracts, queue, and recent interactions
- Commons timeline and conversation relationship view
- contract traceability warnings
- native-git audit records

The UI deliberately avoids a full all-edge graph as the default view because dense message graphs become unreadable. It keeps relationship data inspectable through focused seat and conversation views.

## Weak-Model Guardrails

Republic is designed to make weaker models useful without trusting them blindly:

- prompts use extractable hard fields such as workgroup, module, task, status, target seat, and contract terms
- contract traceability checks hard terms against declared files
- dependency gate records or blocks cross-module writes
- execution-phase writes can require Republic context before mutation
- stale pending work and repeated failures can escalate to stronger agents
- noisy active records can be archived with GC while preserving evidence

The lesson from Ling/Hy3 testing is that weak-model governance should rely on small hard fields plus tool and hook enforcement, not longer natural-language instructions.

## Difference From Upstream Team Mode

Upstream OMO Team Mode focuses on a live lead/member team flow. Republic focuses on auditable governance:

- persistent seats instead of only live members
- Git common-dir ledger and Commons as the source of truth
- native-git audit integration
- workgroup contracts
- weak-model context gates
- scheduler queue and escalation records
- command-board dashboard
- selector presets for different team sizes

The tradeoff is cost and complexity. Standard remains the default preset; Large and Extreme are available when a task has enough independent modules to justify additional calls.

## Current Verification

Local verification completed so far:

- targeted unit tests for Republic tools, seat allocation, selector display names, model requirements, config assembly, and priority order
- `bun run build`
- OpenCode App smoke runs with local plugin path
- Hy3/Kimi smoke task generated a TypeScript snake game, reached final review, and wrote native-git / Republic state visible in the dashboard
- dashboard refresh state was fixed so expanded rows and selected views survive polling

Known product boundary:

- OpenCode's server plugin API does not currently expose a stable custom in-app panel slot, so Republic opens a local browser dashboard instead of embedding directly into the App chrome.
- A separate long-running daemon would make queued scheduler work stronger than the current in-session/background-session bridge.
- Full continuous integration branch sync and semantic evaluator automation are available as CLI-level building blocks, but should continue to be hardened with more real repositories before being advertised as fully autonomous CI replacement.
