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

## Interpretation

The current Republic design is already distinct from ordinary multi-agent delegation because the collaboration record, contracts, audit log, and seat state all live under the Git common dir. The more important finding is that this approach is especially suited to weaker models. Instead of trusting a weak model to remember everything, the system repeatedly exposes the same hard boundaries through contracts, inboxes, and supervisor checks.

This does not yet prove autonomous "always correct" collaboration. It does show a credible path: use cheap models for bounded seat work, use Commons for communication, use contracts for shared truth, and use deterministic checks plus supervisor intervention for recovery.

## Next Steps

1. Add a persistent scheduler/orchestrator daemon so targeted questions can wake the right seat without relying on the parent CLI session staying alive.
2. Add a model capability gate that tests tool-call compliance before assigning a model to Republic work.
3. Upgrade dependency gates from advisory to hard block in governed mode.
4. Add a contract-diff QA pass that checks public docs, tests, and implementation against locked contract terms.
5. Add a weak-model guardrail profile that compresses injected Republic context into labeled fields, requires pre-edit contract acknowledgement, and fails closed on missing contract/inbox reads for governed execution.
