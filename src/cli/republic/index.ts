import { Command } from "commander"
import { republicDashboard } from "./dashboard"
import { republicStatus } from "./status"

export function createRepublicCommand(): Command {
  const command = new Command("republic")
    .description("Inspect OMO Republic deliberation and native Git audit state")

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
