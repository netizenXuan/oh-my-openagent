/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import type { BackgroundTask } from "../../features/background-agent"
import {
  getNativeGitRepository,
  getRepublicAgentDocPath,
  getRepublicContractPath,
  readRepublicCommonsMessages,
  readRepublicLedgerRecords,
} from "../../shared/git-worktree"
import { createRepublicTools } from "./tools"

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
    "user.name=Republic Tool Test",
    "-c",
    "user.email=republic-tool@example.test",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  ])
}

function createToolContext(directory: string): ToolContext {
  return {
    sessionID: "ses_republic_tools",
    messageID: "msg_republic_tools",
    agent: "sisyphus",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function createDispatchManager(launched: Array<{ agent: string; prompt: string; description: string }>) {
  return {
    async launch(input: { agent: string; prompt: string; description: string }): Promise<BackgroundTask> {
      launched.push({
        agent: input.agent,
        prompt: input.prompt,
        description: input.description,
      })
      return {
        id: `bg_${launched.length}`,
        status: "pending",
        parentSessionId: "ses_republic_tools",
        parentMessageId: "msg_republic_tools",
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
      }
    },
  }
}

function createPluginInputWithAgents(directory: string, agents: Array<{ name: string; mode?: "subagent" | "primary" | "all" }>): PluginInput {
  return {
    directory,
    client: {
      app: {
        agents: async () => ({ data: agents }),
      },
    },
  } as unknown as PluginInput
}

describe("republic tools", () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "omo-republic-tools-"))
    initRepo(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test("publishes targeted commons messages and reads inbox", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Can API publish the response contract before implementation?",
      author_seat_id: "docs-seat",
      target_seat_id: "api-seat",
      workgroup_id: "wg-src-api",
      module: "src/api",
      files: ["src/api/orders.ts"],
    }, context)
    const inboxResult = await tools.republic_inbox.execute({
      seat_id: "api-seat",
      include_agent_doc: true,
    }, context)

    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")
    const ledger = readRepublicLedgerRecords(repository, "session-ses_republic_tools")

    expect(JSON.parse(String(publishResult)).message_type).toBe("question")
    expect(String(inboxResult)).toContain("Can API publish")
    expect(messages).toHaveLength(1)
    expect(ledger).toHaveLength(1)
    expect(existsSync(getRepublicAgentDocPath(repository, "api-seat"))).toBe(true)
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("resolves repository from tool context when plugin input directory is unavailable", async () => {
    const tools = createRepublicTools({} as PluginInput)
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Can docs confirm the shared contract?",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
    }, context)

    expect(JSON.parse(String(publishResult)).ok).toBe(true)
    expect(readRepublicCommonsMessages(getNativeGitRepository(directory)!, "session-ses_republic_tools")).toHaveLength(1)
  })

  test("auto-dispatches targeted questions to a background seat", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools({ directory } as PluginInput, {
      manager: createDispatchManager(launched),
      config: {
        enabled: true,
        mode: "advisory",
        ledger: true,
        house_seats: 3,
        senate_seats: 2,
        review_bench_seats: 2,
        quorum: 4,
        supermajority: 0.67,
        veto_on_blocker: true,
        git_summary: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 6,
          agent_docs: true,
        },
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
        contracts: {
          enabled: true,
        },
        scheduler: {
          enabled: true,
          auto_dispatch: true,
          message_types: ["question", "handoff", "objection"],
          default_agent: "sisyphus",
          supervisor_agent: "hephaestus",
          seat_agents: {
            "docs-seat": "hephaestus",
          },
          prompt_max_messages: 8,
        },
      },
    })
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Please confirm the order response enum values.",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      workgroup_id: "wg-src-api",
      module: "src/api",
      files: ["src/api/orders.ts"],
    }, context)

    const parsed = JSON.parse(String(publishResult))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")
    const ledger = readRepublicLedgerRecords(repository, "session-ses_republic_tools")

    expect(parsed.dispatch).toEqual({ taskID: "bg_1", agent: "hephaestus" })
    expect(launched).toHaveLength(1)
    expect(launched[0]?.prompt).toContain('author_seat_id="docs-seat"')
    expect(launched[0]?.prompt).toContain('references=["session-ses_republic_tools-api-seat-question')
    expect(messages.map((message) => message.channel)).toEqual(["commons", "scheduler"])
    expect(messages[1]?.references).toEqual([messages[0]?.messageID])
    expect(ledger.map((record) => record.phase)).toEqual(["collaboration", "dispatch"])
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("falls back to a registered runtime agent for scheduler dispatch", async () => {
    const launched: Array<{ agent: string; prompt: string; description: string }> = []
    const tools = createRepublicTools(createPluginInputWithAgents(directory, [
      { name: "general", mode: "subagent" },
      { name: "explore", mode: "subagent" },
    ]), {
      manager: createDispatchManager(launched),
      config: {
        enabled: true,
        mode: "advisory",
        ledger: true,
        house_seats: 3,
        senate_seats: 2,
        review_bench_seats: 2,
        quorum: 4,
        supermajority: 0.67,
        veto_on_blocker: true,
        git_summary: true,
        commons: {
          auto_publish: true,
          inbox: true,
          inject_max_messages: 6,
          agent_docs: true,
        },
        supervisor: {
          intervention: true,
          policy_loop: true,
          file_threshold: 5,
          high_risk_paths: [],
        },
        dependency_gate: {
          enabled: true,
          mode: "advisory",
          cross_module_threshold: 2,
        },
        contracts: {
          enabled: true,
        },
        scheduler: {
          enabled: true,
          auto_dispatch: true,
          message_types: ["question", "handoff", "objection"],
          default_agent: "sisyphus",
          supervisor_agent: "hephaestus",
          seat_agents: {
            "docs-seat": "hephaestus",
          },
          prompt_max_messages: 8,
        },
      },
    })
    const context = createToolContext(directory)

    const publishResult = await tools.republic_publish.execute({
      message_type: "question",
      content: "Please confirm the public docs shape.",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      workgroup_id: "wg-src-api",
    }, context)

    const parsed = JSON.parse(String(publishResult))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")

    expect(parsed.dispatch).toEqual({ taskID: "bg_1", agent: "general", requested_agent: "hephaestus" })
    expect(launched[0]?.agent).toBe("general")
    expect(launched[0]?.prompt).toContain('Requested OMO role: "hephaestus"')
    expect(launched[0]?.prompt).toContain('Runtime OpenCode agent: "general"')
    expect(messages[1]?.content).toContain("via general (requested hephaestus)")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })

  test("writes workgroup contracts and publishes contract messages", async () => {
    const tools = createRepublicTools({ directory } as PluginInput)
    const context = createToolContext(directory)

    const result = await tools.republic_contract.execute({
      workgroup_id: "wg-src-api",
      title: "Order cancellation response",
      content: "API returns id, status, and cancellationReason.",
      author_seat_id: "api-seat",
      target_seat_id: "docs-seat",
      module: "src/api",
      status: "proposed",
      files: ["src/api/orders.ts", "docs/api/orders.md"],
    }, context)

    const parsed = JSON.parse(String(result))
    const repository = getNativeGitRepository(directory)!
    const messages = readRepublicCommonsMessages(repository, "session-ses_republic_tools")

    expect(parsed.ok).toBe(true)
    expect(readFileSync(getRepublicContractPath(repository, "wg-src-api"), "utf-8")).toContain("Order cancellation response")
    expect(messages[0]?.messageType).toBe("contract")
    expect(git(directory, ["status", "--porcelain"])).toBe("")
  })
})
