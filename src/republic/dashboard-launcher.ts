import {
  openDashboardTarget,
  startRepublicDashboardServer,
  type RepublicDashboardServerHandle,
} from "../cli/republic/dashboard"
import type { RepublicConfig } from "../config"
import type { NativeGitRepository } from "../shared/git-worktree"

export type RepublicDashboardLaunchEvent = "team_init" | "round_start"

type LauncherState = {
  repoRoot: string
  url: string
  server: RepublicDashboardServerHandle
}

type DashboardOpener = (target: string) => boolean

const launchedDashboards = new Map<string, LauncherState>()

function shouldOpenDashboard(config: RepublicConfig | undefined, event: RepublicDashboardLaunchEvent): boolean {
  if (!config?.enabled || config.mode === "manual") {
    return false
  }
  if (config.dashboard?.auto_open !== true) {
    return false
  }
  return (config.dashboard.auto_open_events ?? ["team_init"]).includes(event)
}

export function maybeOpenRepublicDashboard(args: {
  repository: NativeGitRepository
  config: RepublicConfig | undefined
  event: RepublicDashboardLaunchEvent
  deliberationID?: string
  opener?: DashboardOpener
}): { opened: boolean; url?: string; reason?: string } {
  if (!shouldOpenDashboard(args.config, args.event)) {
    return { opened: false, reason: "disabled" }
  }

  const port = args.config?.dashboard?.port ?? 4097
  const refreshMs = args.config?.dashboard?.refresh_ms ?? 2000
  const key = `${args.repository.repoRoot}:${port}`
  const existing = launchedDashboards.get(key)
  const opener = args.opener ?? openDashboardTarget
  if (existing) {
    opener(existing.url)
    return { opened: true, url: existing.url, reason: "already_running" }
  }

  const server = (() => {
    try {
      return startRepublicDashboardServer({
        directory: args.repository.repoRoot,
        port,
        refreshMs,
        deliberationId: args.deliberationID,
      })
    } catch {
      return null
    }
  })()
  if (!server) {
    return { opened: false, url: `http://127.0.0.1:${port}`, reason: "server_unavailable" }
  }

  launchedDashboards.set(key, {
    repoRoot: args.repository.repoRoot,
    url: server.url,
    server,
  })
  opener(server.url)
  return { opened: true, url: server.url, reason: "started" }
}

export function stopRepublicDashboardServers(): void {
  for (const state of launchedDashboards.values()) {
    state.server.stop()
  }
  launchedDashboards.clear()
}
