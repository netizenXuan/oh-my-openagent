# src/agents/ - Agent Definitions

## Overview

Agent factories follow the `createXXXAgent(model) -> AgentConfig` pattern. Each factory has a static `mode` property and is assembled through `createBuiltinAgents()`.

## Built-In Agents

| Agent | Mode | Purpose |
|---|---|---|
| Sisyphus | primary/all style orchestrator | General OMO ultrawork orchestration |
| Republic | primary | Persistent-seat Republic planning, execution, Commons, contracts, supervisor governance, dashboard, and native-git records |
| Hephaestus | primary/all style worker | Deep autonomous implementation |
| Atlas | primary | Plan execution and todo-oriented work |
| Prometheus | primary/internal planner | Strategic planning |
| Oracle | subagent | Read-only consultation |
| Librarian | subagent | External docs and code search |
| Explore | subagent | Codebase exploration |
| Multimodal-Looker | subagent | Image/PDF inspection |
| Metis | subagent | Pre-planning consultation |
| Momus | subagent | Plan critique |
| Sisyphus-Junior | all | Category-spawned executor |

## Tool Restrictions

- Republic denies `task` and `call_omo_agent` so active Republic seats do not create a second legacy OMO fan-out plan.
- Atlas denies `task` and `call_omo_agent`.
- Read-only agents such as Oracle, Librarian, Explore, and Multimodal-Looker deny write/edit style tools.

## Structure

```text
agents/
  sisyphus.ts
  republic.ts
  hephaestus.ts
  oracle.ts
  librarian.ts
  explore.ts
  multimodal-looker.ts
  metis.ts
  momus.ts
  atlas/
  builtin-agents.ts
  builtin-agents/
```

Model resolution is defined in `src/shared/model-requirements.ts` and applied by the `builtin-agents/*-agent.ts` config factories.
