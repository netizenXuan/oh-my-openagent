# OMO Republic Engineering Organization

This document describes the larger design target behind OMO Republic. The goal is not simply to launch more agents. The goal is to model an engineering organization where agents can coordinate like teams working on a large project.

## Design Goal

Large software projects need more than a planner and a set of isolated workers. They need:

- independent proposals before consensus
- module workgroups for related code areas
- frequent cross-seat communication between dependent tasks
- supervisors who can interrupt drift
- durable records for decisions, messages, file changes, and implementation state
- a graph view that makes the organization inspectable and later editable

OMO Republic treats Git as the durable source of truth and OpenCode agents as the execution surface.

## Prior Art

This design combines several proven ideas rather than copying one framework:

- MetaGPT-style SOP: encode repeatable engineering process instead of ad hoc chat.
- GitAgent-style Git-native records: keep agent identity, decisions, and audits in versioned or Git-adjacent files.
- AutoGen-style conversation: agents should be able to converse, not only return reports to a supervisor.
- Blackboard architecture: use a shared workspace where agents publish state and other agents react.
- Linda tuple-space coordination: messages are independent objects that can be read later by loosely coupled workers.

OMO Republic's distinct bet is to combine these with OpenCode's existing primary-agent and background-agent model, while keeping records under the Git common dir so the worktree stays clean.

## Organization Model

### Leadership

One or two supervisor seats hold the global project state. Their role is not to implement every module. Their role is to:

- maintain the task graph
- identify cross-module coupling
- interrupt agents that drift from scope
- force unresolved dependencies into Commons messages
- decide whether a plan can move from deliberation to execution

Supervisor interventions are written as Commons messages with `supervisorSeatID`, `targetSeatID`, `taskID`, and `status`.

The current implementation records these interventions automatically when a native-git tracked tool call touches high-risk paths, changes many files, or when planner/orchestrator seats cross execution boundaries. A lightweight supervisor policy loop also runs on idle and records `supervisor-policy` messages when Commons contains unresolved questions, dependency blocks, or prior interventions.

### Workgroups

Workgroups represent module-level teams:

- `api-workgroup`
- `ui-workgroup`
- `storage-workgroup`
- `integration-workgroup`
- `qa-workgroup`

Each workgroup owns one or more modules and task IDs. Workgroup members should publish frequent Commons messages when:

- a module contract changes
- a dependency blocks progress
- a task changes status
- a local implementation choice affects another module
- a supervisor redirects the group

The dependency gate now performs a lightweight preflight check for explicit path tools. If one call touches multiple inferred modules, it writes a dependency-gate Commons message before execution. In advisory mode that is a warning; in governed block mode it becomes a hard gate.

Workgroups can now publish contracts before implementation. A contract describes the shared API shape, data structure, test boundary, handoff rule, or ownership constraint that adjacent seats must honor. Contracts are stored under `.git/omo/republic/contracts/` and are also published as Commons messages.

### Same-Role Seats

OMO Republic intentionally uses multiple seats for the same role. For example, three planning seats or two reviewer seats. This creates independent judgments before consensus, which is different from adding more expert titles.

The default protocol is:

1. Round 0: independent proposals.
2. Round 1: cross-examination by message ID.
3. Round 2: revision, remaining objection, or consensus.
4. Conference synthesis.
5. Review bench.

### Execution Workgroups

For implementation, the same pattern extends beyond planning:

- each module worker gets `workgroupID`, `module`, `taskID`, and `dependsOn`
- workers in related modules exchange Commons messages
- supervisors monitor `status` and native-git audit records
- `republic dashboard` visualizes nodes and edges

This allows execution to look like a network of cooperating module teams, not a queue of isolated subtasks.

## Git-Native Record Layout

```text
.git/omo/republic/ledger.jsonl
.git/omo/republic/commons.jsonl
.git/omo/republic/deliberations/<id>/
.git/omo/native-git/audit.jsonl
```

`ledger.jsonl` records durable phase outcomes, votes, task ownership, workgroups, and status.

`commons.jsonl` records the communication network: proposals, questions, answers, objections, revisions, consensus, and supervisor notes.

`agents/<seat-id>.md` mirrors messages into readable per-seat working docs, so a later turn can quickly recover what that seat asked, answered, objected to, or received from another seat.

`contracts/<workgroup-id>.md` stores shared workgroup contracts before coupled modules implement against each other.

`audit.jsonl` records tool-caused Git changes, including visible agent/model/category metadata when available.

## Interactive Commons Loop

The implemented collaboration loop is asynchronous and Git-native:

1. A seat publishes a targeted `question`, `proposal`, `objection`, `revision`, or `handoff` with `republic_publish`.
2. Another seat reads relevant messages with `republic_inbox` and replies by referencing the original message ID.
3. A supervisor can publish a policy or intervention message when messages conflict or remain unresolved.
4. Before the next chat turn, OMO injects the current seat's relevant inbox as `<republic-commons-inbox>`.
5. The seat continues with the new context, or writes a `republic_contract` when the dependency needs an explicit agreement.

This is intentionally different from unbounded live chat. Records stay inspectable, recoverable, and attributable through Git common-dir artifacts.

## Dashboard Model

The dashboard converts records into a graph:

- nodes: repository, deliberation, chamber, workgroup, seat, agent, task, message, module, file, tool, decision
- edges: deliberates, contains, coordinates, assigns, supervises, owns, depends-on, runs, published, targets, references, discusses, reviews, changed

This graph is intentionally close to a future visual editor. A later UI can let users drag nodes, create custom workgroups, define supervisor seats, and connect task dependencies before execution.

## Implementation Roadmap

1. Advisory recording:
   - ledger, commons, native-git audit, status, dashboard
   - automatic Commons publication from native-git changes
   - automatic supervisor intervention records
   - advisory dependency gate for cross-workgroup writes
   - interactive Commons inbox, per-seat docs, policy-loop prompts, and workgroup contracts
2. Governed execution:
   - hard dependency gate for cross-workgroup explicit write tools
   - enforce supervisor approval before high-risk execution
   - require explicit dependency acknowledgements before dependent modules proceed
3. Worktree isolation:
   - per-workgroup or per-task branches/worktrees
   - merge and conflict reporting in the dashboard
4. Visual orchestration:
   - draggable graph editor
   - custom teams, roles, dependencies, and communication lanes
5. Productization:
   - project templates for common engineering organizations
   - CI export for status, audit, and dashboard artifacts

## Current Verification Notes

The first OpenCode smoke pass used `kimi-for-coding/k2p6` with a local plugin path. It verified that all four primary agents can participate in the Git-native record stream:

- Hephaestus can now be explicitly run on Kimi K2.x without being redirected to Sisyphus.
- Sisyphus and Atlas produce native-git audit records with stable agent/model attribution.
- Prometheus remains constrained to planning files under `.sisyphus/`, and its allowed plan write is still audited.
- The dashboard can render native-git audit records into agent, tool, file, and module nodes even before a Republic ledger exists.

The current layer has moved from recording into first-stage collaborative governance: automatic Commons publication, supervisor intervention, dependency gates, interactive inbox messages, per-seat docs, policy-loop records, prompt injection, and workgroup contracts are live. It is still not a complete engineering operating system; per-workgroup worktrees, merge orchestration, strict dependency acknowledgement enforcement, and true live multi-agent streaming remain next-stage work.
