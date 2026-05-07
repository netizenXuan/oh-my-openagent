# src/hooks/keyword-detector/ - Mode Keyword Injection

## Overview

Transform-tier hook on `chat.message`. It scans user text for low-friction mode keywords and prepends a mode-specific instruction block before the original prompt.

## Keywords

| Keyword | Pattern | Effect |
|---|---|---|
| `ultrawork` / `ulw` | `/\b(ultrawork\|ulw)\b/i` | OMO ultrawork mode with broad agent/tool usage guidance |
| `repwork` / `republicwork` | `/\b(repwork\|republicwork)\b/i` | OMO Republic mode with persistent seats, Commons, contracts, supervisor governance, and native-git records |
| Search mode | `SEARCH_PATTERN` | Web/doc search focus prompt injection |
| Analyze mode | `ANALYZE_PATTERN` | Deep analysis prompt injection |

Do not use the ordinary word `republic` as a trigger. It is too likely to appear in normal architecture discussion.

## Structure

```text
keyword-detector/
  index.ts
  hook.ts
  detector.ts
  constants.ts
  ultrawork/
  republic/
  search/
  analyze/
```

## Guards

- System directive messages are skipped.
- Background task sessions are skipped.
- Non-OMO agents are skipped.
- Non-main sessions only keep ultrawork triggers.
- Planner agents do not receive ultrawork injection.
