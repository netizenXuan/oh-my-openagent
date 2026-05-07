/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendRepublicCommonsMessage,
  appendRepublicSeatMemory,
  getNativeGitAuditPath,
  getNativeGitRepository,
  initializeRepublicTeam,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
  writeRepublicContract,
  writeRepublicSeatState,
} from "../../shared/git-worktree"
import { createNativeGitHook, NATIVE_GIT_TASK_REMINDER } from "./hook"

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd()
}

function initRepo(cwd: string): void {
  git(cwd, ["init"])
  writeFileSync(join(cwd, "README.md"), "hello\n", "utf-8")
  git(cwd, ["add", "."])
  git(cwd, [
    "-c",
    "user.name=Native Git Test",
    "-c",
    "user.email=native-git@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  ])
}

async function captureToolBaseline(
  hook: ReturnType<typeof createNativeGitHook>,
  input: { tool: string; sessionID: string; callID: string },
): Promise<void> {
  await hook.event({
    event: {
      type: "tool.execute",
      properties: {
        name: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
      },
    },
  })
}

describe("native git hook", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-native-git-hook-"))
    initRepo(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("manual mode does not change output or write audit", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "manual", audit_log: true })
    writeFileSync(join(directory, "README.md"), "changed\n", "utf-8")
    const output = { output: "updated", metadata: {} }

    await hook["tool.execute.after"]({ tool: "edit", sessionID: "ses_test", callID: "call_1" }, output)

    const repository = getNativeGitRepository(directory)
    expect(output.output).toBe("updated")
    expect(repository).not.toBeNull()
    expect(existsSync(getNativeGitAuditPath(repository!))).toBe(false)
  })

  test("tracked mode records audit and appends change summary for write tools", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    await captureToolBaseline(hook, { tool: "edit", sessionID: "ses_test", callID: "call_1" })
    writeFileSync(join(directory, "README.md"), "changed\n", "utf-8")
    const output: { output?: string; metadata?: Record<string, unknown> } = {
      output: "updated",
      metadata: {
        agent: "atlas",
        model: "kimi-for-coding/k2p6",
        category: "quick",
      },
    }

    await hook["tool.execute.after"]({ tool: "edit", sessionID: "ses_test", callID: "call_1" }, output)

    const repository = getNativeGitRepository(directory)
    const auditPath = getNativeGitAuditPath(repository!)
    expect(output.output).toContain("Native Git tracking detected uncommitted changes")
    expect(output.output).toContain("README.md")
    expect(readFileSync(auditPath, "utf-8")).toContain('"tool":"edit"')
    expect(readFileSync(auditPath, "utf-8")).toContain('"agent":"atlas"')
    expect(readFileSync(auditPath, "utf-8")).toContain('"model":"kimi-for-coding/k2p6"')
    expect(readFileSync(auditPath, "utf-8")).toContain('"category":"quick"')
    expect(git(directory, ["status", "--porcelain"])).toContain("README.md")
  })

  test("tracked mode publishes native git changes to republic commons", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      { enabled: true, mode: "advisory", ledger: true, commons: { auto_publish: true } } as never,
    )
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_republic", callID: "call_republic" })
    mkdirSync(join(directory, "src"))
    writeFileSync(join(directory, "src", "feature.ts"), "export const feature = true\n", "utf-8")

    await hook["tool.execute.after"](
      { tool: "write", sessionID: "ses_republic", callID: "call_republic" },
      {
        output: "created",
        metadata: {
          agent: "sisyphus",
          model: "kimi-for-coding/k2p6",
          category: "quick",
        },
      },
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_republic")
    const ledger = readRepublicLedgerRecords(repository!, "session-ses_republic")

    expect(commons).toHaveLength(1)
    expect(commons[0]?.messageType).toBe("status")
    expect(commons[0]?.authorAgent).toBe("sisyphus")
    expect(commons[0]?.workgroupID).toBe("wg-src")
    expect(commons[0]?.files).toEqual(["src/feature.ts"])
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.agent).toBe("sisyphus")
    expect(ledger[0]?.model).toBe("kimi-for-coding/k2p6")
    expect(git(directory, ["status", "--porcelain"])).toContain("src/")
    expect(git(directory, ["status", "--porcelain"])).not.toContain(".git/omo/republic")
  })

  test("tracked mode injects relevant republic inbox messages into chat prompt", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 4,
          agent_docs: true,
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      deliberationID: "session-ses_inbox",
      channel: "commons",
      phase: "cross-examination",
      authorSeatID: "docs-seat",
      targetSeatID: "sisyphus-executor",
      workgroupID: "wg-src-api",
      module: "src/api",
      messageType: "question",
      content: "Should the API expose cancellationReason?",
    })
    const output = {
      parts: [{ type: "text", text: "Implement src/api/orders.ts" }],
    }

    await hook["chat.message"]?.({
      sessionID: "ses_inbox",
      agent: "sisyphus",
      model: { providerID: "kimi-for-coding", modelID: "k2p6" },
      promptText: "Implement src/api/orders.ts",
    }, output)

    expect(output.parts[0]?.text).toContain("<republic-commons-inbox>")
    expect(output.parts[0]?.text).toContain("Should the API expose cancellationReason")
  })

  test("tracked mode injects persistent republic team state into chat prompt", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 4,
          agent_docs: true,
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "sisyphus-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
            reason: "Current OpenCode agent owns API implementation.",
          },
          {
            seatID: "docs-seat",
            role: "planner",
            phase: "planning",
            workgroupID: "wg-docs-api",
            module: "docs/api",
            runtimeAgent: "hephaestus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "session-ses_team",
        activeRound: 2,
        lockedContracts: ["wg-src-api"],
      },
    })
    writeRepublicContract(repository, {
      workgroupID: "wg-src-api",
      title: "Order API Contract",
      content: "OrderRequest must use customerID and discountCode exactly.",
      authorSeatID: "api-planner-seat",
      status: "accepted",
    })
    writeRepublicSeatState(repository, {
      seatID: "sisyphus-executor",
      role: "executor",
      runtimeAgent: "sisyphus",
      status: "waiting",
      phase: "execution",
      workgroupID: "wg-src-api",
      module: "src/api",
      waitingOn: ["docs-seat"],
    })
    appendRepublicSeatMemory(repository, "sisyphus-executor", "Use the locked order API contract before editing routes.")
    const output = {
      parts: [{ type: "text", text: "Continue src/api/orders.ts" }],
    }

    await hook["chat.message"]?.({
      sessionID: "ses_team",
      agent: "sisyphus",
      model: { providerID: "kimi-for-coding", modelID: "k2p6" },
      promptText: "Continue src/api/orders.ts",
    }, output)

    expect(output.parts[0]?.text).toContain("<republic-team-state>")
    expect(output.parts[0]?.text).toContain("phase: execution/in-progress")
    expect(output.parts[0]?.text).toContain("current_seat: sisyphus-executor")
    expect(output.parts[0]?.text).toContain("waiting_on: docs-seat")
    expect(output.parts[0]?.text).toContain("operating_checklist")
    expect(output.parts[0]?.text).toContain("Do not create or update dependencies")
    expect(output.parts[0]?.text).toContain("locked_contract_excerpts")
    expect(output.parts[0]?.text).toContain("discountCode exactly")
    expect(output.parts[0]?.text).toContain("Use the locked order API contract")
  })

  test("tracked mode maps main-session republic context to supervisor when no seat matches", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 4,
          agent_docs: true,
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "api-planner-seat",
            role: "planner",
            phase: "planning",
            workgroupID: "api-workgroup",
            module: "api",
            runtimeAgent: "general",
          },
          {
            seatID: "test-planner-seat",
            role: "planner",
            phase: "planning",
            workgroupID: "test-workgroup",
            module: "test",
            runtimeAgent: "general",
          },
          {
            seatID: "republic-supervisor",
            role: "supervisor",
            phase: "planning",
            runtimeAgent: "general",
          },
        ],
      },
      phase: {
        phase: "planning",
        status: "in-progress",
        deliberationID: "session-ses_main_team",
      },
    })
    const output = {
      parts: [{ type: "text", text: "Use OMO Republic governance." }],
    }

    await hook["chat.message"]?.({
      sessionID: "ses_main_team",
      agent: "sisyphus",
      model: { providerID: "openrouter", modelID: "tencent/hy3-preview:free" },
      promptText: "Use OMO Republic governance.",
    }, output)

    expect(output.parts[0]?.text).toContain("<republic-team-state>")
    expect(output.parts[0]?.text).toContain("current_seat: republic-supervisor")
    expect(output.parts[0]?.text).not.toContain("sisyphus-executor (not in current team manifest)")
  })

  test("tracked mode injects republic constraints through messages transform", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 4,
          agent_docs: true,
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "sisyphus-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "session-ses_transform",
        lockedContracts: ["wg-src-api"],
      },
    })
    writeRepublicContract(repository, {
      workgroupID: "wg-src-api",
      title: "Order API Contract",
      content: "OrderRequest must use customerID and discountCode exactly.",
      authorSeatID: "api-planner-seat",
      status: "accepted",
    })

    await hook["chat.message"]?.({
      sessionID: "ses_transform",
      agent: "sisyphus",
      model: { providerID: "openrouter", modelID: "inclusionai/ling-2.6-1t:free" },
      promptText: "Continue src/api/orders.ts",
    }, { parts: [{ type: "text", text: "Continue src/api/orders.ts" }] })

    const output = {
      messages: [
        {
          info: { id: "msg_1", role: "user", sessionID: "ses_transform" },
          parts: [{ type: "text", text: "Continue src/api/orders.ts" }],
        },
      ],
    }

    await hook["experimental.chat.messages.transform"]?.({} as never, output as never)

    expect(output.messages[0]?.parts).toHaveLength(2)
    expect(output.messages[0]?.parts[0]?.text).toContain("<republic-team-state>")
    expect(output.messages[0]?.parts[0]?.text).toContain("operating_checklist")
    expect(output.messages[0]?.parts[0]?.text).toContain("Do not create or update dependencies")
    expect(output.messages[0]?.parts[0]?.text).toContain("locked_contract_excerpts")
    expect(output.messages[0]?.parts[0]?.text).toContain("discountCode exactly")
    expect(output.messages[0]?.parts[1]?.text).toBe("Continue src/api/orders.ts")
  })

  test("session idle records supervisor policy for unresolved commons questions", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      messageID: "question-1",
      deliberationID: "session-ses_policy",
      channel: "commons",
      phase: "cross-examination",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      messageType: "question",
      content: "Can docs confirm the public API contract?",
    })

    await hook.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "ses_policy",
        },
      },
    })

    const commons = readRepublicCommonsMessages(repository, "session-ses_policy")
    const policy = commons.find((message) => message.messageType === "supervisor-policy")
    const ledger = readRepublicLedgerRecords(repository, "session-ses_policy")

    expect(policy?.content).toContain("unresolved question")
    expect(policy?.references).toContain("question-1")
    expect(ledger.some((record) => record.phase === "policy-loop")).toBe(true)

    await hook.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "ses_policy",
        },
      },
    })

    expect(readRepublicCommonsMessages(repository, "session-ses_policy").filter((message) => message.messageType === "supervisor-policy")).toHaveLength(1)
  })

  test("session idle scans custom deliberations for unresolved commons questions", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      messageID: "custom-question-1",
      deliberationID: "custom-contract",
      channel: "commons",
      phase: "collaboration",
      authorSeatID: "api-seat",
      targetSeatID: "docs-seat",
      messageType: "question",
      content: "Should the API publish a shared response contract?",
    })

    await hook.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "ses_policy_custom",
        },
      },
    })

    const commons = readRepublicCommonsMessages(repository, "custom-contract")
    const policy = commons.find((message) => message.messageType === "supervisor-policy")

    expect(policy?.references).toContain("custom-question-1")
  })

  test("session idle records supervisor policy for unresolved objections", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    appendRepublicCommonsMessage(repository, {
      messageID: "objection-1",
      deliberationID: "session-ses_objection_policy",
      channel: "commons",
      phase: "collaboration",
      authorSeatID: "docs-seat",
      targetSeatID: "api-seat",
      messageType: "objection",
      content: "The proposed API response shape conflicts with the documentation contract.",
    })

    await hook.event({
      event: {
        type: "session.idle",
        properties: {
          sessionID: "ses_objection_policy",
        },
      },
    })

    const commons = readRepublicCommonsMessages(repository, "session-ses_objection_policy")
    const policy = commons.find((message) => message.messageType === "supervisor-policy")

    expect(policy?.content).toContain("unresolved objection")
    expect(policy?.references).toContain("objection-1")
  })

  test("tracked mode records supervisor intervention for high-risk changes", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: { auto_publish: true },
        supervisor: {
          intervention: true,
          file_threshold: 5,
          high_risk_paths: ["package.json"],
        },
      } as never,
    )
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_supervisor", callID: "call_supervisor" })
    writeFileSync(join(directory, "package.json"), "{\"scripts\":{\"test\":\"bun test\"}}\n", "utf-8")
    const output: { output?: string; metadata?: Record<string, unknown> } = {
      output: "created",
      metadata: {
        agent: "atlas",
        model: "kimi-for-coding/k2p6",
      },
    }

    await hook["tool.execute.after"](
      { tool: "write", sessionID: "ses_supervisor", callID: "call_supervisor" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_supervisor")
    const intervention = commons.find((message) => message.messageType === "intervention")

    expect(intervention?.authorAgent).toBe("republic-supervisor")
    expect(intervention?.targetSeatID).toBe("atlas-executor")
    expect(intervention?.content).toContain("high-risk path touched")
    expect(intervention?.content).toContain("orchestrator agent modified implementation files directly")
    expect(output.output).toContain("Republic supervisor intervention recorded")
  })

  test("tracked mode records supervisor intervention for prompt path drift", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: { auto_publish: true },
        supervisor: {
          intervention: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
      } as never,
    )
    await hook["chat.message"]?.({
      sessionID: "ses_drift",
      agent: "sisyphus",
      model: { providerID: "kimi-for-coding", modelID: "k2p6" },
      promptText: "Only update src/api/orders.ts and docs/api/orders.md.",
    })
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_drift", callID: "call_drift" })
    mkdirSync(join(directory, "src", "utils"), { recursive: true })
    writeFileSync(join(directory, "src", "utils", "dateUtils.ts"), "export const today = () => new Date()\n", "utf-8")
    const output: { output?: string; metadata?: Record<string, unknown> } = {
      output: "created",
      metadata: {
        agent: "sisyphus",
        model: "kimi-for-coding/k2p6",
      },
    }

    await hook["tool.execute.after"](
      { tool: "write", sessionID: "ses_drift", callID: "call_drift" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_drift")
    const intervention = commons.find((message) => message.messageType === "intervention")

    expect(intervention?.content).toContain("changed files outside explicit user-mentioned paths")
    expect(intervention?.content).toContain("src/utils/dateUtils.ts")
    expect(output.output).toContain("Republic supervisor intervention recorded")
  })

  test("dependency gate records advisory commons messages before cross-workgroup writes", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
      } as never,
    )
    const output: { args: Record<string, unknown>; message?: string } = {
      args: {
        edits: [
          { filePath: "src/api/routes.ts" },
          { filePath: "docs/api/contract.md" },
        ],
      },
    }

    await hook["tool.execute.before"]?.(
      { tool: "multiedit", sessionID: "ses_gate", callID: "call_gate" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_gate")

    expect(output.message).toContain("Republic workgroup dependency gate")
    expect(commons).toHaveLength(1)
    expect(commons[0]?.messageType).toBe("dependency-blocked")
    expect(commons[0]?.status).toBe("review-required")
    expect(commons[0]?.files).toEqual(["docs/api/contract.md", "src/api/routes.ts"])
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("weak model guardrail records advisory pre-edit when locked contracts were not received", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        weak_model_guardrails: {
          enabled: true,
          labeled_context: true,
          require_context_before_edit: true,
          require_explicit_context_read: false,
          pre_edit_context_gate: "advisory",
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "sisyphus-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "order-guard",
        lockedContracts: ["wg-src-api"],
      },
    })

    const output = { args: { filePath: "src/api/orders.ts" }, message: undefined as string | undefined }
    await hook["tool.execute.before"]?.({ tool: "write", sessionID: "ses_guard", callID: "call_guard" }, output)

    expect(output.message).toContain("Republic weak-model guardrail recorded")
    expect(output.message).toContain("hard_dependency_rule")
    const commons = readRepublicCommonsMessages(repository, "order-guard")
    expect(commons[0]?.channel).toBe("guardrail")
    expect(commons[0]?.messageType).toBe("supervisor-policy")
    expect(commons[0]?.status).toBe("review-required")
    expect(commons[0]?.files).toEqual(["src/api/orders.ts"])
  })

  test("weak model guardrail accepts injected republic context before edits", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 4,
          agent_docs: true,
        },
        weak_model_guardrails: {
          enabled: true,
          labeled_context: true,
          require_context_before_edit: true,
          require_explicit_context_read: false,
          pre_edit_context_gate: "advisory",
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "sisyphus-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "order-context",
        lockedContracts: ["wg-src-api"],
      },
    })

    await hook["chat.message"]?.({
      sessionID: "ses_context_gate",
      agent: "sisyphus",
      promptText: "Continue src/api/orders.ts",
    }, { parts: [{ type: "text", text: "Continue src/api/orders.ts" }] })
    const output = { args: { filePath: "src/api/orders.ts" }, message: undefined as string | undefined }
    await hook["tool.execute.before"]?.({ tool: "write", sessionID: "ses_context_gate", callID: "call_context_gate" }, output)

    expect(output.message).toBeUndefined()
    expect(readRepublicCommonsMessages(repository, "order-context")).toEqual([])
  })

  test("weak model guardrail can require explicit inbox or team status read in governed block mode", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        weak_model_guardrails: {
          enabled: true,
          labeled_context: true,
          require_context_before_edit: true,
          require_explicit_context_read: true,
          pre_edit_context_gate: "block",
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "sisyphus-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "order-explicit",
        lockedContracts: ["wg-src-api"],
      },
    })

    await expect(hook["tool.execute.before"]?.(
      { tool: "write", sessionID: "ses_explicit", callID: "call_blocked" },
      { args: { filePath: "src/api/orders.ts" } },
    )).rejects.toThrow("Republic weak-model guardrail blocked")

    await hook["tool.execute.after"]?.(
      { tool: "republic_inbox", sessionID: "ses_explicit", callID: "call_inbox" },
      { output: "read inbox", metadata: {} },
    )
    const output = { args: { filePath: "src/api/orders.ts" }, message: undefined as string | undefined }
    await hook["tool.execute.before"]?.(
      { tool: "write", sessionID: "ses_explicit", callID: "call_allowed" },
      output,
    )

    expect(output.message).toBeUndefined()
  })

  test("weak model guardrail requires a fresh explicit context read for a new prompt", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        weak_model_guardrails: {
          enabled: true,
          labeled_context: true,
          require_context_before_edit: true,
          require_explicit_context_read: true,
          pre_edit_context_gate: "block",
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "sisyphus-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "order-fresh-context",
        lockedContracts: ["wg-src-api"],
      },
    })

    await hook["tool.execute.after"]?.(
      { tool: "republic_team_status", sessionID: "ses_fresh_context", callID: "call_status" },
      { output: "read team status", metadata: {} },
    )
    await hook["chat.message"]?.(
      { sessionID: "ses_fresh_context", agent: "sisyphus", promptText: "new order implementation task" },
      { parts: [{ type: "text", text: "new order implementation task" }] },
    )

    await expect(hook["tool.execute.before"]?.(
      { tool: "write", sessionID: "ses_fresh_context", callID: "call_stale_context" },
      { args: { filePath: "src/api/orders.ts" } },
    )).rejects.toThrow("Republic weak-model guardrail blocked")
  })

  test("weak model guardrail rolls back post-change edits when before hook was missed", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        commons: { auto_publish: true },
        weak_model_guardrails: {
          enabled: true,
          labeled_context: true,
          require_context_before_edit: true,
          require_explicit_context_read: true,
          pre_edit_context_gate: "block",
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "api-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "order-post-change",
        lockedContracts: ["wg-src-api"],
      },
    })

    mkdirSync(join(directory, "src", "api"), { recursive: true })
    writeFileSync(join(directory, "src", "api", "orders.ts"), "export const order = true\n", "utf-8")
    const output = { output: "write complete", metadata: { agent: "sisyphus" } }

    await hook["tool.execute.after"]?.(
      { tool: "write", sessionID: "ses_post_guard", callID: "call_post_guard" },
      output,
    )

    const commons = readRepublicCommonsMessages(repository, "order-post-change")
    const ledger = readRepublicLedgerRecords(repository, "order-post-change")
    expect(existsSync(join(directory, "src", "api", "orders.ts"))).toBe(false)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
    expect(output.output).toContain("Republic weak-model guardrail blocked")
    expect(output.output).toContain("restored_files: src/api/orders.ts")
    expect(existsSync(getNativeGitAuditPath(repository))).toBe(false)
    expect(commons[0]?.phase).toBe("post-change")
    expect(commons[0]?.status).toBe("blocked")
    expect(commons[0]?.files).toEqual(["src/api/orders.ts"])
    expect(ledger[0]?.phase).toBe("post-change")
    expect(ledger[0]?.status).toBe("blocked")
  })

  test("weak model guardrail records post-change violation without rollback when baseline is dirty", async () => {
    writeFileSync(join(directory, "README.md"), "dirty before hook\n", "utf-8")
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        commons: { auto_publish: true },
        weak_model_guardrails: {
          enabled: true,
          labeled_context: true,
          require_context_before_edit: true,
          require_explicit_context_read: true,
          pre_edit_context_gate: "block",
        },
      } as never,
    )
    const repository = getNativeGitRepository(directory)!
    initializeRepublicTeam(repository, {
      manifest: {
        teamModel: "parliament_squad",
        seatAllocation: "auto",
        maxParallelSeats: 4,
        defaultRuntimeAgent: "general",
        seats: [
          {
            seatID: "api-executor",
            role: "executor",
            phase: "execution",
            workgroupID: "wg-src-api",
            module: "src/api",
            runtimeAgent: "sisyphus",
          },
        ],
      },
      phase: {
        phase: "execution",
        status: "in-progress",
        deliberationID: "order-post-dirty",
        lockedContracts: ["wg-src-api"],
      },
    })

    mkdirSync(join(directory, "src", "api"), { recursive: true })
    writeFileSync(join(directory, "src", "api", "orders.ts"), "export const order = true\n", "utf-8")
    const output = { output: "write complete", metadata: { agent: "sisyphus" } }

    await hook["tool.execute.after"]?.(
      { tool: "write", sessionID: "ses_post_dirty", callID: "call_post_dirty" },
      output,
    )

    const commons = readRepublicCommonsMessages(repository, "order-post-dirty")
    expect(existsSync(join(directory, "src", "api", "orders.ts"))).toBe(true)
    expect(output.output).toContain("rollback_skipped: repository was already dirty before this tool call")
    expect(commons[0]?.phase).toBe("post-change")
    expect(commons[0]?.status).toBe("blocked")
  })

  test("dependency gate blocks in governed block mode", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        dependency_gate: {
          enabled: true,
          mode: "block",
          cross_module_threshold: 2,
        },
      } as never,
    )
    const output: { args: Record<string, unknown>; message?: string } = {
      args: {
        edits: [
          { filePath: "src/api/routes.ts" },
          { filePath: "docs/api/contract.md" },
        ],
      },
    }

    await expect(
      hook["tool.execute.before"]?.(
        { tool: "multiedit", sessionID: "ses_block", callID: "call_block" },
        output,
      ),
    ).rejects.toThrow("Republic workgroup dependency gate")

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_block")
    expect(commons[0]?.status).toBe("blocked")
  })

  test("dependency gate detects mutating bash commands with cross-workgroup paths", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
      } as never,
    )
    const output: { args: Record<string, unknown>; message?: string } = {
      args: {
        command: "Set-Content src/api/orders.ts 'api'; Add-Content docs/api/orders.md 'docs'",
      },
    }

    await hook["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_bash_gate", callID: "call_bash_gate" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_bash_gate")
    expect(output.message).toContain("Republic workgroup dependency gate")
    expect(commons[0]?.files).toEqual(["docs/api/orders.md", "src/api/orders.ts"])
  })

  test("dependency gate records post-change messages for cumulative cross-workgroup edits", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: { auto_publish: true },
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
      } as never,
    )
    mkdirSync(join(directory, "src"))
    mkdirSync(join(directory, "docs"))
    await captureToolBaseline(hook, { tool: "edit", sessionID: "ses_post_gate", callID: "call_post_gate" })
    writeFileSync(join(directory, "src", "feature.ts"), "export const enabled = true\n", "utf-8")
    writeFileSync(join(directory, "docs", "feature.md"), "# Feature\n", "utf-8")
    const output = { output: "updated", metadata: { agent: "sisyphus" } }

    await hook["tool.execute.after"]?.(
      { tool: "edit", sessionID: "ses_post_gate", callID: "call_post_gate" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_post_gate")
    const dependencyGate = commons.find((message) => message.channel === "dependency-gate")

    expect(dependencyGate?.phase).toBe("post-change")
    expect(dependencyGate?.status).toBe("review-required")
    expect(dependencyGate?.files).toEqual(["docs/feature.md", "src/feature.ts"])
    expect(output.output).toContain("Republic workgroup dependency gate recorded")
  })

  test("dependency gate marks post-change cross-workgroup edits blocked in governed mode", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        commons: { auto_publish: true },
        dependency_gate: {
          enabled: true,
          mode: "block",
          cross_module_threshold: 2,
        },
      } as never,
    )
    mkdirSync(join(directory, "src"))
    mkdirSync(join(directory, "docs"))
    await captureToolBaseline(hook, { tool: "bash", sessionID: "ses_post_block", callID: "call_post_block" })
    writeFileSync(join(directory, "src", "feature.ts"), "export const enabled = true\n", "utf-8")
    writeFileSync(join(directory, "docs", "feature.md"), "# Feature\n", "utf-8")
    const output = { output: "updated", metadata: { agent: "sisyphus" } }

    await hook["tool.execute.after"]?.(
      { tool: "bash", sessionID: "ses_post_block", callID: "call_post_block" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_post_block")
    const dependencyGate = commons.find((message) => message.channel === "dependency-gate")

    expect(dependencyGate?.phase).toBe("post-change")
    expect(dependencyGate?.status).toBe("blocked")
    expect(output.output).toContain("Republic workgroup dependency gate blocked")
  })

  test("generated artifact gate records generated output changes", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        commons: { auto_publish: true },
      } as never,
    )
    await captureToolBaseline(hook, { tool: "bash", sessionID: "ses_generated", callID: "call_generated" })
    mkdirSync(join(directory, "dist", "game"), { recursive: true })
    writeFileSync(join(directory, "dist", "game", "Snake.js.map"), "{}", "utf-8")
    const output = { output: "built", metadata: { agent: "sisyphus" } }

    await hook["tool.execute.after"]?.(
      { tool: "bash", sessionID: "ses_generated", callID: "call_generated" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_generated")
    const generatedGate = commons.find((message) => message.authorSeatID === "generated-artifact-gate")

    expect(generatedGate?.status).toBe("review-required")
    expect(generatedGate?.files).toEqual([
      "dist/game/Snake.js.map",
    ])
    expect(output.output).toContain("Republic generated-artifact gate recorded")
  })

  test("generated artifact gate rolls back generated files in governed mode", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "governed",
        ledger: true,
        commons: { auto_publish: true },
        weak_model_guardrails: {
          enabled: true,
          generated_artifact_gate: "block",
          generated_artifact_paths: ["dist/", "node_modules/"],
        },
      } as never,
    )
    await captureToolBaseline(hook, { tool: "bash", sessionID: "ses_generated_block", callID: "call_generated_block" })
    mkdirSync(join(directory, "dist"), { recursive: true })
    writeFileSync(join(directory, "dist", "main.js"), "console.log('built')\n", "utf-8")
    const output = { output: "built", metadata: { agent: "sisyphus" } }

    await hook["tool.execute.after"]?.(
      { tool: "bash", sessionID: "ses_generated_block", callID: "call_generated_block" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    const commons = readRepublicCommonsMessages(repository!, "session-ses_generated_block")
    const generatedGate = commons.find((message) => message.authorSeatID === "generated-artifact-gate")

    expect(existsSync(join(directory, "dist", "main.js"))).toBe(false)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
    expect(generatedGate?.status).toBe("blocked")
    expect(output.output).toContain("Republic generated-artifact gate blocked")
    expect(output.output).toContain("restored_files: dist/main.js")
  })

  test("dependency gate ignores read-only bash commands", async () => {
    const hook = createNativeGitHook(
      { directory } as never,
      { mode: "tracked", audit_log: true },
      {
        enabled: true,
        mode: "advisory",
        ledger: true,
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
      } as never,
    )
    const output: { args: Record<string, unknown>; message?: string } = {
      args: {
        command: "Get-Content src/api/orders.ts; Get-Content docs/api/orders.md",
      },
    }

    await hook["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_read_gate", callID: "call_read_gate" },
      output,
    )

    const repository = getNativeGitRepository(directory)
    expect(output.message).toBeUndefined()
    expect(readRepublicCommonsMessages(repository!, "session-ses_read_gate")).toEqual([])
  })

  test("tracked mode attributes changes from chat session context when tool metadata is missing", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    await hook["chat.message"]?.({
      sessionID: "ses_context",
      agent: "Hephaestus - Deep Agent",
      model: { providerID: "kimi-for-coding", modelID: "k2p6" },
    })
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_context", callID: "call_context" })
    writeFileSync(join(directory, "context.txt"), "created with session context\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "write",
            callID: "call_context",
            sessionID: "ses_context",
            state: { status: "completed" },
          },
        },
      },
    })

    const repository = getNativeGitRepository(directory)
    const audit = readFileSync(getNativeGitAuditPath(repository!), "utf-8")
    expect(audit).toContain('"agent":"hephaestus"')
    expect(audit).toContain('"model":"kimi-for-coding/k2p6"')
    expect(audit).toContain("context.txt")
  })

  test("tracked mode does not attribute pre-existing dirty state to a tracked tool", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    writeFileSync(join(directory, "README.md"), "already dirty\n", "utf-8")
    await captureToolBaseline(hook, { tool: "bash", sessionID: "ses_dirty", callID: "call_read" })
    const output = { output: "listed files", metadata: {} }

    await hook["tool.execute.after"]({ tool: "bash", sessionID: "ses_dirty", callID: "call_read" }, output)

    const repository = getNativeGitRepository(directory)
    expect(output.output).toBe("listed files")
    expect(repository).not.toBeNull()
    expect(existsSync(getNativeGitAuditPath(repository!))).toBe(false)
  })

  test("tracked mode uses initial clean state when tool execute baseline is missing", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    writeFileSync(join(directory, "missing-baseline.txt"), "created without execute event\n", "utf-8")
    const output = { output: "write complete", metadata: {} }

    await hook["tool.execute.after"]({ tool: "write", sessionID: "ses_missing", callID: "call_missing" }, output)

    const repository = getNativeGitRepository(directory)
    const audit = readFileSync(getNativeGitAuditPath(repository!), "utf-8")
    expect(output.output).toContain("Native Git tracking detected uncommitted changes")
    expect(output.output).toContain("missing-baseline.txt")
    expect(audit).toContain('"callID":"call_missing"')
    expect(audit).toContain("missing-baseline.txt")
  })

  test("tracked mode keeps initial dirty state as fallback when execute baseline is missing", async () => {
    writeFileSync(join(directory, "README.md"), "dirty before hook creation\n", "utf-8")
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    const output = { output: "listed files", metadata: {} }

    await hook["tool.execute.after"]({ tool: "bash", sessionID: "ses_initial_dirty", callID: "call_read" }, output)

    const repository = getNativeGitRepository(directory)
    expect(output.output).toBe("listed files")
    expect(repository).not.toBeNull()
    expect(existsSync(getNativeGitAuditPath(repository!))).toBe(false)
  })

  test("tracked mode records audit from tool result events", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_event", callID: "call_event" })
    writeFileSync(join(directory, "event.txt"), "created by event\n", "utf-8")

    await hook.event({
      event: {
        type: "tool.result",
        properties: { name: "write", sessionID: "ses_event", callID: "call_event" },
      },
    })

    const repository = getNativeGitRepository(directory)
    const auditPath = getNativeGitAuditPath(repository!)
    const audit = readFileSync(auditPath, "utf-8")
    expect(audit).toContain('"tool":"write"')
    expect(audit).toContain('"sessionID":"ses_event"')
    expect(audit).toContain("event.txt")
  })

  test("tracked mode records audit from completed tool part events", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_part", callID: "call_part" })
    writeFileSync(join(directory, "part-event.txt"), "created by tool part\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "write",
            callID: "call_part",
            sessionID: "ses_part",
            state: { status: "completed" },
          },
        },
      },
    })

    const repository = getNativeGitRepository(directory)
    const auditPath = getNativeGitAuditPath(repository!)
    const audit = readFileSync(auditPath, "utf-8")
    expect(audit).toContain('"tool":"write"')
    expect(audit).toContain('"sessionID":"ses_part"')
    expect(audit).toContain('"callID":"call_part"')
    expect(audit).toContain("part-event.txt")
  })

  test("tool execute after still appends summary when completed event uses event-level call id", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_shared", callID: "call_shared" })
    writeFileSync(join(directory, "shared-state.txt"), "created by tool part\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          callID: "call_shared",
          part: {
            type: "tool",
            tool: "write",
            sessionID: "ses_shared",
            state: { status: "completed" },
          },
        },
      },
    })

    const output = { output: "write complete", metadata: {} }
    await hook["tool.execute.after"]({ tool: "write", sessionID: "ses_shared", callID: "call_shared" }, output)

    const repository = getNativeGitRepository(directory)
    const records = readFileSync(getNativeGitAuditPath(repository!), "utf-8").trim().split("\n")
    expect(records).toHaveLength(1)
    expect(output.output).toContain("Native Git tracking detected uncommitted changes")
    expect(output.output).toContain("shared-state.txt")
  })

  test("tracked mode records repeated edits to the same file set", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    await captureToolBaseline(hook, { tool: "edit", sessionID: "ses_repeat", callID: "call_first" })
    writeFileSync(join(directory, "README.md"), "first change\n", "utf-8")

    await hook["tool.execute.after"]({ tool: "edit", sessionID: "ses_repeat", callID: "call_first" }, { output: "", metadata: {} })

    await captureToolBaseline(hook, { tool: "edit", sessionID: "ses_repeat", callID: "call_second" })
    writeFileSync(join(directory, "README.md"), "second change\n", "utf-8")

    await hook["tool.execute.after"]({ tool: "edit", sessionID: "ses_repeat", callID: "call_second" }, { output: "", metadata: {} })

    const repository = getNativeGitRepository(directory)
    const records = readFileSync(getNativeGitAuditPath(repository!), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { callID: string; files: string[] })

    expect(records).toHaveLength(2)
    expect(records[0]?.callID).toBe("call_first")
    expect(records[1]?.callID).toBe("call_second")
    expect(records[0]?.files).toEqual(["README.md"])
    expect(records[1]?.files).toEqual(["README.md"])
  })

  test("tracked mode records additional files created inside the same untracked directory", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: true })
    mkdirSync(join(directory, "nested"))
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_nested", callID: "call_first" })
    writeFileSync(join(directory, "nested", "first.txt"), "first\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "write",
            callID: "call_first",
            sessionID: "ses_nested",
            state: { status: "completed" },
          },
        },
      },
    })

    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_nested", callID: "call_second" })
    writeFileSync(join(directory, "nested", "second.txt"), "second\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "write",
            callID: "call_second",
            sessionID: "ses_nested",
            state: { status: "completed" },
          },
        },
      },
    })

    const repository = getNativeGitRepository(directory)
    const auditPath = getNativeGitAuditPath(repository!)
    const records = readFileSync(auditPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { callID: string; files: string[]; summary: string })

    expect(records).toHaveLength(2)
    expect(records[0]?.callID).toBe("call_first")
    expect(records[0]?.files).toContain("nested/first.txt")
    expect(records[1]?.callID).toBe("call_second")
    expect(records[1]?.files).toContain("nested/second.txt")
    expect(records[1]?.summary).toContain("nested/second.txt")
  })

  test("session deleted clears native git reminder state", async () => {
    const showToast = mock(() => Promise.resolve({}))
    const hook = createNativeGitHook(
      { directory, client: { tui: { showToast } } } as never,
      { mode: "tracked", audit_log: true },
    )
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_deleted", callID: "call_deleted" })
    writeFileSync(join(directory, "deleted-session.txt"), "created before delete\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "write",
            callID: "call_deleted",
            sessionID: "ses_deleted",
            state: { status: "completed" },
          },
        },
      },
    })
    await hook.event({ event: { type: "session.deleted", properties: { info: { id: "ses_deleted" } } } })
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "ses_deleted" } } })

    expect(showToast).not.toHaveBeenCalled()
  })

  test("tracked mode shows one git-master reminder toast on session idle", async () => {
    const showToast = mock(() => Promise.resolve({}))
    const hook = createNativeGitHook(
      { directory, client: { tui: { showToast } } } as never,
      { mode: "tracked", audit_log: true },
    )
    await captureToolBaseline(hook, { tool: "write", sessionID: "ses_toast", callID: "call_toast" })
    writeFileSync(join(directory, "toast.txt"), "created for toast\n", "utf-8")

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "write",
            callID: "call_toast",
            sessionID: "ses_toast",
            state: { status: "completed" },
          },
        },
      },
    })
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "ses_toast" } } })
    await hook.event({ event: { type: "session.idle", properties: { sessionID: "ses_toast" } } })

    expect(showToast).toHaveBeenCalledTimes(1)
    const toast = showToast.mock.calls[0]?.[0]
    expect(toast?.body?.title).toBe("Native Git changes tracked")
    expect(toast?.body?.message).toContain("git-master")
    expect(toast?.body?.variant).toBe("warning")
  })

  test("task output receives git-master commit reminder when changes remain", async () => {
    const hook = createNativeGitHook({ directory } as never, { mode: "tracked", audit_log: false })
    writeFileSync(join(directory, "README.md"), "changed\n", "utf-8")
    const output = { output: "task complete", metadata: {} }

    await hook["tool.execute.after"]({ tool: "task", sessionID: "ses_test", callID: "call_1" }, output)

    expect(output.output).toContain(NATIVE_GIT_TASK_REMINDER.trim())
    expect(output.output).toContain('task(category="quick", load_skills=["git-master"]')
  })
})
