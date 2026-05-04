import { Command } from "commander"
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

  return command
}
