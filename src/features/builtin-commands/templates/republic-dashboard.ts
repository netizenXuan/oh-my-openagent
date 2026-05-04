export const REPUBLIC_DASHBOARD_TEMPLATE = `You are helping the user inspect the OMO Republic collaboration graph.

## ARGUMENTS

- \`/republic-dashboard [deliberation-id] [--serve] [--port=4097]\`
  - \`deliberation-id\` (optional): filter graph data to one deliberation.
  - \`--serve\` (optional): start a live local dashboard.
  - \`--port\` (optional): local dashboard port.

## WHAT TO DO

1. Confirm the current directory is inside a Git repository.
2. If \`--serve\` is present, run:
   - \`oh-my-opencode republic dashboard --serve --directory <repo-root> --port <port>\`
3. Otherwise, run:
   - \`oh-my-opencode republic dashboard --directory <repo-root>\`
4. If a deliberation ID was provided, pass:
   - \`--deliberation-id <id>\`
5. Report the dashboard path or live URL.

## SAFETY

- Do not modify project source files.
- Do not run commits, branch mutations, reset, checkout, or stash.
- The dashboard output defaults to \`.git/omo/republic/dashboard.html\`, so it does not dirty the worktree.

## DASHBOARD MEANING

Explain that the graph shows:

- repository, deliberation, chamber, workgroup, seat, agent, task, message, module, file, tool, and decision nodes
- assignment, supervision, dependency, publication, targeting, references, discussed files, and code-change edges
- a Commons timeline for cross-seat communication

If no Republic records exist, suggest running \`/deliberate <problem-or-plan>\` first.`
