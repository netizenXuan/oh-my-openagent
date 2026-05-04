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
.git/omo/republic/deliberations/<deliberation-id>/
```

Native Git tracking writes tool-caused file changes separately:

```text
.git/omo/native-git/audit.jsonl
```

Because both locations are inside `.git`, neither the deliberation ledger nor native-git audit records dirty the worktree.

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

## Operating Model

Use OMO Republic when the task has high review cost, unclear architecture tradeoffs, or a high chance of hidden coupling. For routine edits, use the normal agent flow and native-git audit.

A typical session:

1. Run `/deliberate "Should we migrate the API client to a shared retry layer?"`.
2. Let the House and Senate seats produce independent proposals.
3. Read the conference report and review bench blockers.
4. Run `/republic-status` to verify ledger and native-git audit state.
5. Execute the accepted plan.
6. Use `git-master` to make atomic commits.
