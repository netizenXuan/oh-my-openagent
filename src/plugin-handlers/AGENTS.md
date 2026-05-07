# src/plugin-handlers/ - Config Loading Pipeline

## Critical Agent Ordering

The canonical core agent order is:

```text
sisyphus -> republic -> hephaestus -> prometheus -> atlas
```

This order is enforced by two cooperating mechanisms:

1. `CANONICAL_CORE_AGENT_ORDER` in `agent-priority-order.ts` controls object key insertion order in the agent map produced by `applyAgentConfig`.
2. `installAgentSortShim()` in `src/shared/agent-sort-shim.ts` narrows `Array.prototype.toSorted` and `Array.prototype.sort` so that when the sorted array contains two or more agent objects whose `.name` matches a canonical core display name, OpenCode's `Agent.list()` returns the canonical order.

Republic is a primary agent entry, not a subagent. It starts the existing OMO Republic governance system from the App selector and keeps Republic seats exclusive from legacy `task` / `call_omo_agent` fan-out.

## Why A Sort Shim

OpenCode 1.4.x sorts agents by `agent.name` and currently ignores the `order` field. Object-key insertion order alone does not survive `Agent.list()`. Earlier attempts to bias names with invisible characters caused visible gaps and truncation regressions in the TUI and App.

The sort shim is intentionally narrow:

- `isAgentArray` requires at least two elements, every element must be a non-null object with a string `.name`, and at least two elements must match canonical core display names.
- Mixed-type arrays, plain objects without `.name`, number arrays, and string arrays keep native sort behavior.
- `installAgentSortShim()` is idempotent.

## Forbidden Patterns

Do not introduce:

- Zero-width characters, soft hyphens, ANSI escape sequences, or other invisible/control characters in agent names, display names, or object keys.
- Visible sort prefixes on agent names.
- Alternative ordering constants outside `CANONICAL_CORE_AGENT_ORDER`.
- Agent name comparisons that skip `getAgentConfigKey` / `stripInvisibleAgentCharacters`.

Remove the shim once OpenCode honors the agent `order` field.
