# Republic Governance Experiments, 2026-05-06

This note records the first practical A/B pass for OMO Republic as a Git-native multi-agent governance layer. The goal was not to prove a universal benchmark win. The goal was to find out whether the current design can make weaker, cheaper models more reliable by surrounding them with contracts, explicit seats, supervisor review, and native Git evidence.

## Hypothesis

Weak or inexpensive models can be useful on complex engineering work when the system constrains them with:

- short seat-level prompts instead of one large ambiguous prompt
- explicit workgroup contracts before execution
- targeted ask/reply through Republic Commons
- supervisor policy and dependency gates
- native-git audit records for every tool-caused change
- final deterministic verification with tests and typecheck

The expected benefit is not raw intelligence. The expected benefit is reduced drift, clearer accountability, and cheaper parallel work.

## Experiment Design

All experiments used a small TypeScript order workflow project as the target. The target required API, domain, test, docs, and config changes around order acceptance, rejection, shipment events, and configuration.

Model and workflow variants:

| Variant | Model | Workflow | Result |
| --- | --- | --- | --- |
| Hy3 control | `tencent/hy3-preview:free` | single agent | Implemented a direct task successfully, with native-git audit records. |
| Hy3 treatment | `tencent/hy3-preview:free` | Republic tools | Failed tool-call compliance; the model printed pseudo tool XML instead of calling tools. |
| Ling control | `inclusionai/ling-2.6-1t:free` | single agent | Implemented a direct task successfully, tests passed, but the CLI run timed out during final narrative output. |
| Ling treatment v1-v3 | `inclusionai/ling-2.6-1t:free` | Republic tools | Exposed prompt-drift failures: contract wording drift, experiment-word contamination, and invalid shell commands. |
| Ling treatment v4 | `inclusionai/ling-2.6-1t:free` | Republic with short explicit seat sessions | Produced usable governance evidence, contracts, inter-seat ask/reply, supervisor intervention, and passing final verification. |
| Kimi check | `kimi-for-coding/k2p6` | CLI smoke | CLI channel recovered; Kimi read injected Republic team state, operating checklist, locked contract excerpts, and the hard dependency rule. |
| Kimi control | `kimi-for-coding/k2p6` | single agent with native-git tracking | Implemented order cancellation support, passed tests and typecheck, and produced 4 native-git audit records but no Republic Commons records. |
| Kimi treatment | `kimi-for-coding/k2p6` | Republic-guided single session | Implemented the same task, passed tests and typecheck, initialized an auto team, wrote a contract, and produced Commons, ledger, dependency-gate, and supervisor records. |

## Ling v4 Setup

Repository:

```text
D:\OMO\republic-governance-ling-v4-20260506
```

Team initialization used `team_model=parliament_squad` and `seat_allocation=auto`. The allocator produced 11 seats:

- `config-planner-seat`, `docs-planner-seat`, `api-planner-seat`, `test-planner-seat`
- `config-executor-seat`, `docs-executor-seat`, `api-executor-seat`, `test-executor-seat`
- `config-review-seat`, `docs-review-seat`
- `republic-supervisor`

The team locked four workgroup contracts before execution:

```text
.git/omo/republic/contracts/api-workgroup.md
.git/omo/republic/contracts/config-workgroup.md
.git/omo/republic/contracts/docs-workgroup.md
.git/omo/republic/contracts/test-workgroup.md
```

Final recorded counts:

| Record type | Count |
| --- | ---: |
| Republic Commons messages | 100 |
| Republic ledger records | 100 |
| Native-git audit records | 21 |
| Locked contracts | 4 |

## Observed Collaboration

The strongest positive signal was not that every seat behaved perfectly. It was that the workflow made mistakes visible and recoverable.

One real ask/reply path occurred during planning:

1. `test-planner-seat` published a targeted question to `api-planner-seat` about rejection strings and shipment behavior.
2. The scheduler recorded a dispatch event.
3. The supervisor policy loop detected one unresolved question.
4. `api-planner-seat` read its inbox and answered with exact rejection strings.
5. The answer was recorded in Commons and became available to other seats.

Supervisor and dependency gates also found useful issues:

- `api-executor-seat` touched `bun.lock` and created a helper `typecheck.js`, which was outside its workgroup. The dependency gate and supervisor intervention flagged the boundary crossing.
- `docs-review-seat` caught a `customerId` versus `customerID` mismatch in public docs.
- Final manual QA still found a docs mismatch around `productId` versus `sku`, showing that reviewer seats need stronger final contract-diff checks.

## Final Verification

After the Ling v4 repair and final polish, the target project passed:

```text
bun test
bun node_modules\typescript\bin\tsc --noEmit
git diff --check
```

Final changed worktree files in the target project:

```text
docs/api/orders.md
docs/config.md
src/api/orders.ts
src/config/index.ts
src/domain/orders.ts
tests/orders.test.ts
```

## What Worked

- Dynamic seat allocation matched the project structure without predefining a fixed role list.
- Contracts under `.git/omo/republic/contracts/` gave later seats a durable source of truth.
- Commons made agent-to-agent questions and answers inspectable after the run.
- Native-git audit captured concrete tool-caused file changes without dirtying the worktree.
- Supervisor and dependency gates caught several weak-model failure modes that a single-agent run would have hidden in the final diff.

## What Failed

- Background Republic rounds launched through the CLI did not reliably keep working after the parent CLI session exited. The successful v4 pattern used short explicit seat sessions.
- Hy3 was not tool-call reliable enough for Republic tools in this environment.
- Ling can execute tool calls, but it is highly sensitive to prompt wording. Phrases like "experiment" caused it to optimize for an experiment design instead of the product task.
- Weak models still need deterministic final QA. Reviewer seats caught some mismatches, but not all.
- Kimi was unavailable during the first experiment window, then later recovered and passed the context-injection smoke.

## Engineering Changes From This Pass

The experiment directly motivated stronger weak-model constraints in Republic prompts:

- round prompts now include constrained operating rules
- seat inbox output now includes current phase state
- seat inbox output now includes locked contract excerpts
- execution seats are told not to create dependencies, lockfiles, generated scripts, global config, or helper files unless explicitly allowed
- execution seats are told to keep edits inside their workgroup or publish a handoff/objection and stop
- tests assert that these constraints are present in the generated prompts and inbox output

After this change, a Ling smoke check was run against the v4 experiment repository. The model was instructed not to edit files and to call `republic_inbox` for `api-executor-seat` with `include_agent_doc=true`. Ling successfully called the tool and confirmed that the inbox contained all four expected constraint anchors:

- `Operating Checklist`
- `Locked Contracts`
- `Do not create or update dependencies`
- `customerID`

No additional worktree changes were created by this smoke check.

Follow-up smoke checks then moved the same constraints into the pre-send message transform, so seats can receive Republic context even when they do not proactively call `republic_inbox`.

Results:

| Smoke check | Model | Result |
| --- | --- | --- |
| explicit inbox | `inclusionai/ling-2.6-1t:free` | Passed. Ling called `republic_inbox` and saw operating checklist, locked contracts, dependency rule, and contract field names. |
| automatic context | `kimi-for-coding/k2p6` | Passed. Kimi reported `republic-team-state`, `operating_checklist`, `locked_contract_excerpts`, exact contract fields, and the dependency rule. |
| automatic context | `inclusionai/ling-2.6-1t:free` | Partial. Ling detected contract fields and the hard dependency rule after the rule was given a stable `hard_dependency_rule` label, but it still misclassified one marker presence check. |

This is the main weak-model lesson: cheap models should not be governed only by prose. They need short, labeled, repeated constraints plus deterministic tool-level gates.

The lesson has now been implemented as a first-class guardrail profile:

- Republic prompts expose the dependency rule with a stable `hard_dependency_rule` label.
- `weak_model_guardrails.labeled_context` is enabled by default so critical constraints remain easy to extract.
- `weak_model_guardrails.require_context_before_edit` is enabled by default so execution-phase writes with locked contracts require Republic context before mutating tools proceed.
- Advisory mode records a `channel: "guardrail"` / `messageType: "supervisor-policy"` Commons entry when a seat starts editing before receiving the locked execution context.
- Governed mode can hard-block the same case with `weak_model_guardrails.pre_edit_context_gate: "block"`.
- `weak_model_guardrails.require_explicit_context_read: true` can require a real `republic_inbox` or `republic_team_status` call instead of accepting injected context.
- Governed mode now also has a post-change fail-closed fallback: if a real runtime misses the preflight hook and writes into a clean repository, OMO restores the changed files and records a `phase: "post-change"` guardrail entry.
- Republic status and dashboard now include deterministic contract traceability: hard terms from contract files are checked against the files declared by those contracts, and missing files or uncovered terms are surfaced as warnings.

## Real CLI Guardrail Finding

A later Kimi CLI smoke showed a product-critical integration issue: the unit-tested `tool.execute.before` guardrail path was not sufficient by itself in the real OpenCode CLI runtime. With Republic read tools disabled and a locked execution contract present, Kimi wrote `src/api/orders.ts`; the `tool.execute.after` audit path fired, but the preflight block did not stop the write in that environment.

The fix was to make the context gate two-layered:

- preflight still blocks when the runtime exposes the write before execution
- post-change fallback re-checks the locked contract context after mutating tools complete
- when the repository was clean before the tool call, post-change fallback restores the touched files
- when the repository was already dirty, it records the violation and skips rollback to avoid deleting unrelated user work
- explicit context reads are scoped to the current prompt, so a reused OpenCode session cannot carry an old Republic read into a new locked-contract task

The new unit coverage asserts both post-change rollback and dirty-baseline no-rollback behavior. This changes the product lesson from "add a before hook" to "make weak-model gates observable and fail-closed at the tool boundary the runtime actually guarantees."

Follow-up real OpenCode/Kimi smoke found one Windows-specific edge case: a PowerShell-created `.git/omo/republic/team/phase.json` can include a UTF-8 BOM, which made the phase reader return `null` and caused the post-change gate to think no locked contract existed. The Republic team JSON reader now strips a leading BOM, and unit coverage asserts BOM phase files still expose `phase: "execution"` and `lockedContracts`.

The final negative smoke used the real OpenCode CLI, local plugin path, `kimi-for-coding/k2p6`, Republic tools disabled, a locked execution contract, and a clean test repository. Kimi attempted to create `src/api/orders.ts`; the post-change guardrail recorded a `channel: "guardrail"` / `phase: "post-change"` / `status: "blocked"` Commons entry, restored `src/api/orders.ts`, skipped native-git audit for the unauthorized write, and left `git status --short` empty. The guardrail reminder now states that `republic_inbox` and `republic_team_status` are OpenCode tool calls, not `.republic` files, and tells weak models to stop instead of retrying when the required tool is unavailable.

## Clean Kimi A/B: Order Cancellation

After the guardrail fixes, a clean Kimi A/B run used the same initial TypeScript order project and the same model, `kimi-for-coding/k2p6`. The task was to add order cancellation and shipment status support across domain, API, tests, and docs, with no dependency or lockfile changes.

Control repository:

```text
D:\OMO\republic-ab-control-kimi-20260506
```

Treatment repository:

```text
D:\OMO\republic-ab-treatment-kimi-20260506
```

Both runs passed deterministic verification:

```text
bun test
bun node_modules\typescript\bin\tsc --noEmit
```

Results:

| Metric | Kimi control | Kimi treatment |
| --- | ---: | ---: |
| Product files changed | 4 | 4 |
| Tests after run | 5 pass | 5 pass |
| Typecheck after run | pass | pass |
| Native-git audit records | 4 | 4 |
| Republic ledger records | 0 | 18 |
| Republic Commons messages | 0 | 18 |
| Contracts written | 0 | 1 |
| Dependency-gate records | 0 | 3 |
| Supervisor intervention records | 0 | 4 |
| Auto-allocated team seats | 0 | 8 |

Observed behavior:

- The single-agent control completed the code task efficiently and native-git captured each file-changing tool call.
- The Republic treatment also completed the code task, but added a durable planning proposal, a workgroup contract, a phase transition, seat state updates, native-git-to-Commons publication, dependency-gate records, and supervisor interventions for high-risk multi-module edits.
- The treatment dashboard rendered from `.git/omo/republic/dashboard.html` with the simplified workgroup board and Seat Inspector view. Contract traceability reported `Contracts: 1`, `Warnings: 0`, and `api-workgroup: pass`.
- This run was not a full parallel `republic_round_start` execution. It was a Republic-guided single session that proved the governance artifacts can be produced without breaking the product task. Full parallel-seat proof still requires a persistent scheduler benchmark.

## Interpretation

The current Republic design is already distinct from ordinary multi-agent delegation because the collaboration record, contracts, audit log, and seat state all live under the Git common dir. The more important finding is that this approach is especially suited to weaker models. Instead of trusting a weak model to remember everything, the system repeatedly exposes the same hard boundaries through contracts, inboxes, and supervisor checks.

This does not yet prove autonomous "always correct" collaboration. It does show a credible path: use cheap models for bounded seat work, use Commons for communication, use contracts for shared truth, and use deterministic checks plus supervisor intervention for recovery.

## Next Steps

1. Add a persistent scheduler/orchestrator daemon so targeted questions can wake the right seat without relying on the parent CLI session staying alive.
2. Add a model capability gate that tests tool-call compliance before assigning a model to Republic work.
3. Add a contract-diff QA pass that checks public docs, tests, and implementation against locked contract terms.
4. Add per-workgroup worktrees so each execution seat can commit, test, and merge through an isolated Git lane.
5. Add a benchmark harness that runs single-agent, advisory Republic, and governed Republic variants against the same project tasks.
