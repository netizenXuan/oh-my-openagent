/// <reference path="../../../bun-test.d.ts" />

import { afterEach, beforeEach, describe, test, expect } from "bun:test"
import { loadBuiltinCommands } from "./commands"
import { DELIBERATE_TEMPLATE } from "./templates/deliberate"
import { HANDOFF_TEMPLATE } from "./templates/handoff"
import { REMOVE_AI_SLOPS_TEMPLATE } from "./templates/remove-ai-slops"
import { REPUBLIC_DASHBOARD_TEMPLATE } from "./templates/republic-dashboard"
import { REPUBLIC_STATUS_TEMPLATE } from "./templates/republic-status"
import type { BuiltinCommandName } from "./types"
import { _resetForTesting, registerAgentName } from "../claude-code-session-state"

beforeEach(() => {
  _resetForTesting()
})

afterEach(() => {
  _resetForTesting()
})

describe("loadBuiltinCommands", () => {
  test("should include handoff command in loaded commands", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = []

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands.handoff).toBeDefined()
    expect(commands.handoff.name).toBe("handoff")
  })

  test("should exclude handoff when disabled", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = ["handoff"]

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands.handoff).toBeUndefined()
  })

  test("should include handoff template content in command template", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands.handoff.template).toContain(HANDOFF_TEMPLATE)
  })

  test("should include session context variables in handoff template", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands.handoff.template).toContain("$SESSION_ID")
    expect(commands.handoff.template).toContain("$TIMESTAMP")
    expect(commands.handoff.template).toContain("$ARGUMENTS")
  })

  test("should have correct description for handoff", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands.handoff.description).toContain("context summary")
  })

  test("should default start-work to Atlas for static slash-command discovery", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands["start-work"].agent).toBe("atlas")
  })

  test("should preassign Sisyphus as the native agent for start-work when command config checks registered agents", () => {
    //#given - no atlas registration

    //#when
    const commands = loadBuiltinCommands(undefined, { useRegisteredAgents: true })

    //#then
    expect(commands["start-work"].agent).toBe("sisyphus")
  })

  test("should preassign Atlas as the native agent for start-work when Atlas is registered", () => {
    //#given
    registerAgentName("atlas")

    //#when
    const commands = loadBuiltinCommands(undefined, { useRegisteredAgents: true })

    //#then
    expect(commands["start-work"].agent).toBe("atlas")
  })
})

describe("loadBuiltinCommands - remove-ai-slops", () => {
  test("should include remove-ai-slops command in loaded commands", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = []

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands["remove-ai-slops"]).toBeDefined()
    expect(commands["remove-ai-slops"].name).toBe("remove-ai-slops")
  })

  test("should exclude remove-ai-slops when disabled", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = ["remove-ai-slops"]

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands["remove-ai-slops"]).toBeUndefined()
  })

  test("should include remove-ai-slops template content in command template", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands["remove-ai-slops"].template).toContain(REMOVE_AI_SLOPS_TEMPLATE)
  })

  test("should have correct description for remove-ai-slops", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands["remove-ai-slops"].description).toContain("AI-generated code smells")
  })
})

describe("loadBuiltinCommands - deliberate", () => {
  test("should include deliberate command in loaded commands", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = []

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands.deliberate).toBeDefined()
    expect(commands.deliberate.name).toBe("deliberate")
  })

  test("should exclude deliberate when disabled", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = ["deliberate"]

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands.deliberate).toBeUndefined()
  })

  test("should include deliberate template and session context variables", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands.deliberate.template).toContain(DELIBERATE_TEMPLATE)
    expect(commands.deliberate.template).toContain("$SESSION_ID")
    expect(commands.deliberate.template).toContain("$TIMESTAMP")
    expect(commands.deliberate.template).toContain("$ARGUMENTS")
  })

  test("should describe the republic ledger path and multi-seat same-role design", () => {
    //#given - the template string

    //#when / #then
    expect(DELIBERATE_TEMPLATE).toContain("House of Planners")
    expect(DELIBERATE_TEMPLATE).toContain("Senate of Planners")
    expect(DELIBERATE_TEMPLATE).toContain("multiple independent seats for the same role")
    expect(DELIBERATE_TEMPLATE).toContain(".git/omo/republic/ledger.jsonl")
  })
})

describe("loadBuiltinCommands - republic-status", () => {
  test("should include republic-status command in loaded commands", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = []

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands["republic-status"]).toBeDefined()
    expect(commands["republic-status"].name).toBe("republic-status")
  })

  test("should exclude republic-status when disabled", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = ["republic-status"]

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands["republic-status"]).toBeUndefined()
  })

  test("should include ledger and native git audit status instructions", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands["republic-status"].template).toContain(REPUBLIC_STATUS_TEMPLATE)
    expect(commands["republic-status"].template).toContain(".git/omo/republic/ledger.jsonl")
    expect(commands["republic-status"].template).toContain(".git/omo/native-git/audit.jsonl")
    expect(commands["republic-status"].template).toContain("$ARGUMENTS")
  })
})

describe("loadBuiltinCommands - republic-dashboard", () => {
  test("should include republic-dashboard command in loaded commands", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = []

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands["republic-dashboard"]).toBeDefined()
    expect(commands["republic-dashboard"].name).toBe("republic-dashboard")
  })

  test("should exclude republic-dashboard when disabled", () => {
    //#given
    const disabledCommands: BuiltinCommandName[] = ["republic-dashboard"]

    //#when
    const commands = loadBuiltinCommands(disabledCommands)

    //#then
    expect(commands["republic-dashboard"]).toBeUndefined()
  })

  test("should include dashboard instructions", () => {
    //#given - no disabled commands

    //#when
    const commands = loadBuiltinCommands()

    //#then
    expect(commands["republic-dashboard"].template).toContain(REPUBLIC_DASHBOARD_TEMPLATE)
    expect(commands["republic-dashboard"].template).toContain("oh-my-opencode republic dashboard")
    expect(commands["republic-dashboard"].template).toContain(".git/omo/republic/dashboard.html")
    expect(commands["republic-dashboard"].template).toContain("workgroup")
  })
})

describe("REMOVE_AI_SLOPS_TEMPLATE", () => {
  test("should include phase structure", () => {
    //#given - the template string

    //#when / #then
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("Identify Changed Files")
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("Parallel AI Slop Removal")
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("Critical Review")
  })

  test("should reference ai-slop-remover skill", () => {
    //#given - the template string

    //#when / #then
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("ai-slop-remover")
  })

  test("should include safety verification checklist", () => {
    //#given - the template string

    //#when / #then
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("Safety Verification")
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("Behavior Preservation")
  })

  test("should detect the base branch dynamically instead of hardcoding main", () => {
    //#given - the template string

    //#when / #then
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain("git symbolic-ref refs/remotes/origin/HEAD")
    expect(REMOVE_AI_SLOPS_TEMPLATE).toContain('git merge-base "$BASE_BRANCH" HEAD')
    expect(REMOVE_AI_SLOPS_TEMPLATE).not.toContain("git merge-base main HEAD")
  })
})

describe("HANDOFF_TEMPLATE", () => {
  test("should include session reading instruction", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("session_read")
  })

  test("should include compaction-style sections in output format", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("USER REQUESTS (AS-IS)")
    expect(HANDOFF_TEMPLATE).toContain("EXPLICIT CONSTRAINTS")
  })

  test("should include programmatic context gathering instructions", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("todoread")
    expect(HANDOFF_TEMPLATE).toContain("git diff")
    expect(HANDOFF_TEMPLATE).toContain("git status")
  })

  test("should include context extraction format", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("WORK COMPLETED")
    expect(HANDOFF_TEMPLATE).toContain("CURRENT STATE")
    expect(HANDOFF_TEMPLATE).toContain("PENDING TASKS")
    expect(HANDOFF_TEMPLATE).toContain("KEY FILES")
    expect(HANDOFF_TEMPLATE).toContain("IMPORTANT DECISIONS")
    expect(HANDOFF_TEMPLATE).toContain("CONTEXT FOR CONTINUATION")
    expect(HANDOFF_TEMPLATE).toContain("GOAL")
  })

  test("should enforce first person perspective", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("first person perspective")
  })

  test("should limit key files to 10", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("Maximum 10 files")
  })

  test("should instruct plain text format without markdown", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("Plain text with bullets")
    expect(HANDOFF_TEMPLATE).toContain("No markdown headers")
  })

  test("should include user instructions for new session", () => {
    //#given - the template string

    //#when / #then
    expect(HANDOFF_TEMPLATE).toContain("new session")
    expect(HANDOFF_TEMPLATE).toContain("opencode")
  })

  test("should not contain emojis", () => {
    //#given - the template string

    //#when / #then
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u
    expect(emojiRegex.test(HANDOFF_TEMPLATE)).toBe(false)
  })
})
