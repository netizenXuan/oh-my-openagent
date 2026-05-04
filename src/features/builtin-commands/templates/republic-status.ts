export const REPUBLIC_STATUS_TEMPLATE = `You are summarizing the OMO Republic execution state for this repository.

## ARGUMENTS

- \`/republic-status [deliberation-id]\`
  - \`deliberation-id\` (optional): summarize one deliberation. If omitted, summarize all known deliberations.

## WHAT TO READ

If inside a git repository:

1. Resolve repository paths:
   - \`git rev-parse --show-toplevel\`
   - \`git rev-parse --path-format=absolute --git-common-dir\`
2. Read OMO Republic ledger if present:
   - \`.git/omo/republic/ledger.jsonl\`
3. Read OMO Republic commons if present:
   - \`.git/omo/republic/commons.jsonl\`
4. Read native git audit if present:
   - \`.git/omo/native-git/audit.jsonl\`

Do not modify files, do not run commits, and do not create new ledger entries for this status command.

## SUMMARY RULES

Return a compact operational report:

1. Repository root and Git common dir.
2. Deliberation IDs found.
3. Phase counts: brief, seat-proposal, conference-report, review, final.
4. Chamber counts: house, senate, conference, bench.
5. Seat list and vote table.
6. Agent/model participation when visible.
7. Commons summary:
   - channels and phases
   - authors and agents
   - workgroups, modules, and task IDs
   - proposal/question/objection/revision/consensus counts
   - targeted and referenced message counts
8. Blockers or reject votes.
9. Native Git audit summary:
   - tools that changed files
   - agents/models/categories when visible
   - sessions and files touched
10. Recommended next action:
   - continue deliberation
   - revise plan
   - execute plan
   - commit with git-master

If no ledger exists, say that no Republic ledger has been written yet and suggest running \`/deliberate <problem-or-plan>\`.

If native git audit exists but no Republic ledger exists, still summarize native-git activity and explain that tool/file tracking exists without deliberation records.`
