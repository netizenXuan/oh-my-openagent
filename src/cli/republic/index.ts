import { Command } from "commander"
import {
  republicBenchmarkAcceptanceCollector,
  republicBenchmarkReport,
  republicBenchmarkRunCollector,
} from "./benchmark-report"
import { republicDashboard } from "./dashboard"
import { republicStatus } from "./status"

export function createRepublicCommand(): Command {
  const command = new Command("republic")
    .description("Inspect OMO Republic deliberation and native Git audit state")

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
    .option("-o, --output <path>", "Write the report to a file instead of stdout")
    .option("--json", "Output structured JSON")
    .action(async (options) => {
      const exitCode = await republicBenchmarkReport({
        run: options.run,
        acceptance: options.acceptance,
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
