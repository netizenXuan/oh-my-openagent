import { Command } from "commander"
import {
  republicBenchmarkAcceptanceCollector,
  republicBenchmarkCapabilityCollector,
  republicBenchmarkReport,
  republicBenchmarkRunCollector,
} from "./benchmark-report"
import { collectCapabilityContentTerm, republicCapabilityCheck } from "./capability-check"
import { republicContractCheck } from "./contract-check"
import { republicDashboard } from "./dashboard"
import { republicDoctor } from "./doctor"
import { republicIntent } from "./intent"
import { republicIntegrate } from "./integrate"
import { republicScheduler } from "./scheduler"
import { republicStatus } from "./status"
import { republicWorktrees } from "./worktrees"

export function createRepublicCommand(): Command {
  const command = new Command("republic")
    .description("Inspect OMO Republic deliberation and native Git audit state")

  command
    .command("intent")
    .description("Publish staged Git changes as a Republic proposal without committing")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Deliberation id for the proposal")
    .option("--seat-id <seat>", "Authoring seat id")
    .option("--target-seat-id <seat>", "Optional target reviewer or supervisor seat id")
    .option("--workgroup-id <id>", "Optional workgroup id")
    .option("--module <name>", "Optional module name")
    .option("--message <text>", "Proposal message to include before the staged diff summary")
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicIntent({
        directory: options.directory,
        deliberationId: options.deliberationId,
        seatId: options.seatId,
        targetSeatId: options.targetSeatId,
        workgroupId: options.workgroupId,
        module: options.module,
        message: options.message,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("integrate")
    .description("Plan or apply a Republic integration branch merge from workgroup branches")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Deliberation id for generated integration branch")
    .option("--integration-branch <branch>", "Integration branch to create or update")
    .option("--base-ref <ref>", "Base ref for a new integration branch", "HEAD")
    .option("--source-branch <branch>", "Source branch to merge; repeatable", (value, previous: string[]) => previous.concat(value), [])
    .option("--check-command <command>", "Command to run on the integration branch; repeatable", (value, previous: string[]) => previous.concat(value), [])
    .option("--apply", "Create/update the integration branch and merge selected sources")
    .option("--allow-dirty", "Allow apply mode even when the root worktree is dirty")
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicIntegrate({
        directory: options.directory,
        deliberationId: options.deliberationId,
        integrationBranch: options.integrationBranch,
        baseRef: options.baseRef,
        sourceBranch: options.sourceBranch,
        checkCommand: options.checkCommand,
        apply: options.apply ?? false,
        allowDirty: options.allowDirty ?? false,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("worktrees")
    .description("Plan or create per-workgroup Git worktrees")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Deliberation id for generated branch and worktree paths")
    .option("--base-ref <ref>", "Base ref for new worktree branches", "HEAD")
    .option("--root <path>", "Root directory for generated worktrees")
    .option("--create", "Create missing worktrees with git worktree add")
    .option("--allow-dirty", "Allow creation even when the root worktree is dirty")
    .option("-o, --output <path>", "Write the plan to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicWorktrees({
        directory: options.directory,
        deliberationId: options.deliberationId,
        baseRef: options.baseRef,
        root: options.root,
        create: options.create ?? false,
        allowDirty: options.allowDirty ?? false,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("doctor")
    .description("Run a machine-readable Republic health check")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Filter to one deliberation id")
    .option("--strict", "Exit non-zero when warnings are present")
    .option("--max-pending-age-ms <ms>", "Warn when a pending scheduler dispatch is older than this", (value) => Number.parseInt(value, 10))
    .option("--max-failed-per-source <n>", "Warn when one source message has more than this many failed dispatches", (value) => Number.parseInt(value, 10))
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicDoctor({
        directory: options.directory,
        deliberationId: options.deliberationId,
        strict: options.strict ?? false,
        maxPendingAgeMs: options.maxPendingAgeMs,
        maxFailedPerSource: options.maxFailedPerSource,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("contract-check")
    .description("Verify Republic contract hard terms against governed files")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--strict", "Exit non-zero when any contract traceability warning is present")
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicContractCheck({
        directory: options.directory,
        strict: options.strict ?? false,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("capability-check")
    .description("Verify a Republic model/seat run against machine-checkable collaboration evidence")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Filter to one deliberation id")
    .option("--dispatch-id <id>", "Expected scheduler dispatch id")
    .option("--source-message-id <id>", "Expected Commons source message id")
    .option("--expected-author-seat <seat>", "Expected responding seat id")
    .option("--expected-target-seat <seat>", "Expected response target seat id")
    .option("--expected-message-type <type>", "Expected Commons response message type", "answer")
    .option("--require-content <term>", "Required substring in a matching Commons response", collectCapabilityContentTerm, [])
    .option("--expect-clean-worktree", "Fail if the git worktree is dirty")
    .option("--require-dispatched-queue", "Fail unless a matching scheduler queue record reached dispatched status")
    .option("--allow-indirect", "Allow a response to reference the source through the Commons message graph")
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicCapabilityCheck({
        directory: options.directory,
        deliberationId: options.deliberationId,
        dispatchId: options.dispatchId,
        sourceMessageId: options.sourceMessageId,
        expectedAuthorSeat: options.expectedAuthorSeat,
        expectedTargetSeat: options.expectedTargetSeat,
        expectedMessageType: options.expectedMessageType,
        requireContent: options.requireContent,
        expectCleanWorktree: options.expectCleanWorktree ?? false,
        requireDispatchedQueue: options.requireDispatchedQueue ?? false,
        allowIndirect: options.allowIndirect ?? false,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("scheduler")
    .description("Inspect or consume queued Republic scheduler dispatches")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Filter to one deliberation id")
    .option("--limit <n>", "Maximum queued dispatches to inspect or consume", (value) => Number.parseInt(value, 10))
    .option("--write-prompts", "Write wake prompts under .git/omo/republic/scheduler/prompts")
    .option(
      "--command-template <template>",
      "External command to launch each queued dispatch; supports {repo}, {prompt}, {agent}, {target_seat}, {dispatch_id}, {deliberation_id}",
    )
    .option("--watch", "Keep polling the scheduler queue")
    .option("--poll-interval-ms <ms>", "Polling interval for --watch", (value) => Number.parseInt(value, 10))
    .option("--max-cycles <n>", "Maximum watch cycles; mainly useful for tests and smoke runs", (value) => Number.parseInt(value, 10))
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicScheduler({
        directory: options.directory,
        deliberationId: options.deliberationId,
        limit: options.limit,
        writePrompts: options.writePrompts ?? false,
        commandTemplate: options.commandTemplate,
        watch: options.watch ?? false,
        pollIntervalMs: options.pollIntervalMs,
        maxCycles: options.maxCycles,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("benchmark-report")
    .description("Summarize one or more Republic experiment repositories")
    .option(
      "--run <label=path>",
      "Experiment repository to include; repeat for control/treatment runs",
      republicBenchmarkRunCollector,
      [],
    )
    .option(
      "--acceptance <label:check=pass|fail|warn[:detail]>",
      "Acceptance or hidden-QA result to include; repeatable",
      republicBenchmarkAcceptanceCollector,
      [],
    )
    .option(
      "--capability <label=path>",
      "Capability-check JSON report to include for a run; repeatable",
      republicBenchmarkCapabilityCollector,
      [],
    )
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicBenchmarkReport({
        run: options.run,
        acceptance: options.acceptance,
        capability: options.capability,
        output: options.output,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("status")
    .description("Summarize Republic ledger and native Git audit state")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Filter to one deliberation id")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicStatus({
        directory: options.directory,
        deliberationId: options.deliberationId,
        json: options.json ?? false,
      })
      process.exit(exitCode)
    })

  command
    .command("dashboard")
    .description("Render or serve a Republic collaboration graph dashboard")
    .option("-d, --directory <path>", "Working directory to inspect")
    .option("--deliberation-id <id>", "Filter to one deliberation id")
    .option("-o, --output <path>", "HTML output path; defaults to .git/omo/republic/dashboard.html")
    .option("--json", "Output structured graph data instead of HTML")
    .option("--serve", "Serve a live dashboard that polls repository state")
    .option("--port <port>", "Port for --serve", (value) => Number.parseInt(value, 10))
    .option("--refresh-ms <ms>", "Refresh interval for --serve", (value) => Number.parseInt(value, 10))
    .action(async (options) => {
      const exitCode = await republicDashboard({
        directory: options.directory,
        deliberationId: options.deliberationId,
        output: options.output,
        json: options.json ?? false,
        serve: options.serve ?? false,
        port: options.port,
        refreshMs: options.refreshMs,
      })
      process.exit(exitCode)
    })

  return command
}
