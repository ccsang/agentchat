import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createLaunch } from "./binding.ts";
import { atomicWrite, privateDirectory, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { uninstalled } from "./runtime.ts";
import type { Member, Project } from "./types.ts";
import { socketBinding } from "./socket-state.ts";
import { installedCommand, installedToolExists } from "./executable.ts";
import { integrationDir } from "./project.ts";
import { roomName } from "./rooms.ts";
import { integrationSettings, workspaceDir } from "./workspace.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function launcherScript(project: Project, member?: Member, command = installedCommand(project)): string {
  const args = [...command, "--project", project.root, ...(member ? ["--room", roomName(project)] : []), "launch", "claude", ...(member ? ["--to", member.id] : [])];
  return `#!/bin/sh\n# AgentChat managed Claude entry. Host confirmations remain interactive.\nexec ${args.map(quote).join(" ")} "$@"\n`;
}
export function channelConfig(project: Project, member: Member, apply: boolean): Record<string, unknown> {
  requireThat(member.runtime === "claude" && member.session_ref, "E_IDENTITY", "Prepare a launcher for one exact registered Claude session");
  requireThat(installedToolExists(project) && !uninstalled(project), "E_CONFIG", "Install the project CLI before preparing Claude");
  requireThat(socketBinding(project, member)?.enabled || integrationSettings(project).hooks, "E_CONFIG", "Channel requires opt-in project hooks: preview install --hooks, then apply only when the user requests that integration");
  const path = join(workspaceDir(project), "launchers", roomName(project), `${member.name}.command`), script = launcherScript(project, member);
  if (apply) { privateDirectory(join(workspaceDir(project), "launchers", roomName(project))); atomicWrite(path, script, 0o700); }
  return { ok: true, applied: apply, path, script, member_id: member.id, resumes_exact_session: true,
    selected_receiver: socketBinding(project, member)?.enabled ? "claude-socket-experimental" : "channel",
    launch_argv: [path], reception_verified: false,
    requirement: "Exit the existing Claude client, then run this launcher in a user terminal to restore the exact session. It preserves the selected receiver. Channel mode may require host consent; a changed native socket process must be explicitly rebound and verified." };
}
export async function launchClaude(project: Project, member?: Member): Promise<number> {
  requireThat(process.stdin.isTTY && process.stdout.isTTY && !process.env.CODEX_THREAD_ID && !process.env.CLAUDECODE,
    "E_HOST_ACTION", "Run the prepared launcher in the user's terminal; an agent must not start a nested or replacement business session");
  requireThat(!uninstalled(project) && installedToolExists(project), "E_CONFIG", "Install this project before launching Claude");
  const useSocket = !!member && socketBinding(project, member)?.enabled;
  requireThat(useSocket || integrationSettings(project).hooks, "E_CONFIG", "Channel requires explicitly enabled project hooks; use install --hooks to preview the optional integration");
  const bin = Bun.which("claude"); requireThat(bin, "E_HOST", "Claude Code is not available on PATH");
  const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
  requireThat(version.status === 0, "E_HOST", "Cannot inspect the Claude Code executable");
  const launch = createLaunch(project, member?.session_ref ?? null, version.stdout.trim());
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
  for (const key of ["CODEX_THREAD_ID", "AGENTCHAT_CLAUDE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_AGENT_ID", "AGENTCHAT_SUBAGENT"]) delete env[key];
  try {
    const path = join(integrationDir(project), "launches", `${launch.binding.id}.mcp.json`);
    const [command, ...prefix] = installedCommand(project);
    if (!useSocket) writeJson(path, { mcpServers: { agentchat: { command,
      args: [...prefix, "--project", project.root, "notify", "claude-channel"], env: launch.env } } });
    const child = Bun.spawn([bin, ...(member ? ["--resume", member.session_ref!] : []), ...(useSocket ? [] : ["--mcp-config", path,
      "--dangerously-load-development-channels", "server:agentchat"])], { cwd: project.root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    try { launch.attachHost(child.pid); }
    catch (error) { child.kill("SIGTERM"); await child.exited; throw error; }
    const stop = (signal: NodeJS.Signals) => child.kill(signal);
    const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try { return await child.exited; }
    finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
  } finally { launch.close(); }
}
