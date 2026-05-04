export const DELIBERATE_TEMPLATE = `You are running the OMO Republic deliberation protocol.

This command is for opt-in, multi-seat deliberation before implementation. It is inspired by United States institutional design, but keep the output practical and engineering-focused.

## ARGUMENTS

- \`/deliberate <problem-or-plan>\`
  - \`problem-or-plan\`: the decision, design, PR, or implementation plan to deliberate

## CORE IDEA

Do not create more expert titles. Instead, instantiate multiple independent seats for the same role:

1. **House of Planners**: 3 fast planning seats propose independently.
2. **Senate of Planners**: 2 conservative planning seats inspect long-term maintainability and institutional risk.
3. **Conference Committee**: synthesize the conflicting plans into one recommendation.
4. **Review Bench**: 2 reviewer seats check the recommendation before execution.

This mirrors bicameralism, committee review, conference reconciliation, and judicial review. The goal is to reduce single-agent blind spots, overconfidence, and premature consensus.

## SAFETY

- Do not modify project source files unless the user explicitly asks to execute the selected plan after deliberation.
- You may create deliberation records under the Git common dir only.
- Do not run git commit, stash, reset, checkout, or branch mutation commands.
- If the repository is not a git repository, run the deliberation in chat and clearly say that no ledger was written.

## LEDGER

If inside a git repository, store records under the Git common dir so they do not dirty the worktree:

1. Resolve repository paths:
   - \`git rev-parse --show-toplevel\`
   - \`git rev-parse --path-format=absolute --git-common-dir\`
2. Create:
   - \`.git/omo/republic/ledger.jsonl\`
   - \`.git/omo/republic/deliberations/<deliberation_id>/\`
3. Use a stable \`deliberation_id\`: \`delib_<YYYYMMDDHHmmss>_<short-slug>\`.
4. Append one JSONL record per phase or seat:
   - \`version\`: 1
   - \`timestamp\`: ISO timestamp
   - \`repoRoot\`: repository root
   - \`deliberationID\`
   - \`phase\`: brief, seat-proposal, conference-report, review, final
   - \`chamber\`: house, senate, conference, bench
   - \`seatID\`: planner-house-1, planner-senate-1, reviewer-bench-1, etc.
   - \`role\`: planner, reviewer, synthesizer
   - \`agent\`: selected OMO agent name when visible
   - \`model\`: selected model when visible
   - \`sessionID\` and \`callID\` when visible
   - \`vote\`: approve, revise, reject, abstain
   - \`confidence\`: 0.0 to 1.0
   - \`files\`: relevant files, if any
   - \`summary\`: concise one-line finding
5. Write longer artifacts under \`.git/omo/republic/deliberations/<deliberation_id>/\`, such as:
   - \`brief.md\`
   - \`house-seat-1.md\`
   - \`senate-seat-1.md\`
   - \`conference-report.md\`
   - \`review-bench.md\`
   - \`final.md\`

## WORKFLOW

1. **Neutral Brief**
   - Restate the user request from \`$ARGUMENTS\`.
   - List known constraints, repo context needed, and decision criteria.
   - Do not include a preferred solution yet.
   - Write the brief artifact and append a \`brief\` ledger record.

2. **House of Planners**
   - Run 3 independent planner seats.
   - Give each seat the same brief, but tell it not to read other seats first.
   - Each seat must return:
     - Recommendation
     - Plan
     - Risks
     - Tests or verification
     - What would change my mind
     - Confidence
   - Append one \`seat-proposal\` ledger record per seat.

3. **Senate of Planners**
   - Run 2 independent conservative planner seats.
   - Focus them on stability, maintainability, compatibility, review burden, and rollback.
   - Append one \`seat-proposal\` ledger record per seat.

4. **Conference Committee**
   - Compare all planner seats.
   - Extract consensus, unresolved conflicts, minority reports, and the recommended plan.
   - Append a \`conference-report\` ledger record.

5. **Review Bench**
   - Run 2 reviewer seats against the conference report.
   - They should identify blockers, missing tests, hidden coupling, and rollback risk.
   - Append one \`review\` ledger record per seat.

6. **Final Recommendation**
   - Produce a compact final report:
     - Decision
     - Recommended plan
     - Minority concerns
     - Execution gates
     - Git tracking implications
     - Next command to run, if any
   - Append a \`final\` ledger record.

## OUTPUT FORMAT

Return:

1. Deliberation ID
2. Ledger path, or "not written"
3. Final recommendation
4. Vote table
5. Execution gates
6. Next step

Keep the response concise, but preserve dissenting opinions.`
