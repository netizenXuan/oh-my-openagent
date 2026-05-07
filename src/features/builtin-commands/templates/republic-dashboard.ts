export const REPUBLIC_DASHBOARD_TEMPLATE = `You are helping the user inspect the OMO Republic collaboration command board.

## ARGUMENTS

- \`/republic-dashboard [deliberation-id] [--serve] [--open] [--port=4097]\`
  - \`deliberation-id\` (optional): filter dashboard data to one deliberation.
  - \`--serve\` (optional): start a live local dashboard.
  - \`--open\` (optional): open the rendered or served dashboard with the OS default browser.
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
- For Desktop App workflows, users can set \`republic.dashboard.auto_open=true\` so Republic team or round startup opens the live dashboard automatically.

## DASHBOARD MEANING

Explain that the command board shows:

- phase, workgroup, supervisor, seat status, scheduler queue, contract traceability, and native-git record counts
- a click-to-inspect seat detail panel with live state, runtime agent mapping, queue records, contracts, recent interactions, and expandable raw JSON
- a Commons timeline for cross-seat communication

If no Republic records exist, suggest running \`/deliberate <problem-or-plan>\` first.`
