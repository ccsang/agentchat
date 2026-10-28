import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createLaunch } from "./binding.ts";
import { atomicWrite, privateDirectory, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { uninstalled } from "./runtime.ts";
import type { Member, Project } from "./types.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function launcherScript(project: Project, member?: Member): string {
  const args = [process.execPath, join(project.room, "agentchat.js"), "--project", project.root, "launch", "claude", ...(member ? ["--to", member.id] : [])];
  return `#!/bin/sh\n# AgentChat managed Claude entry. Host confirmations remain interactive.\nexec ${args.map(quote).join(" ")} "$@"\n`;
}
export function channelConfig(project: Project, member: Member, apply: boolean): Record<string, unknown> {
  requireThat(member.runtime === "claude" && member.session_ref, "E_IDENTITY", "Prepare a launcher for one exact registered Claude session");
  requireThat(existsSync(join(project.room, "agentchat.js")) && !uninstalled(project), "E_CONFIG", "Install the project CLI before preparing Claude");
  const path = join(project.room, "launchers", `${member.name}.command`), script = launcherScript(project, member);
  if (apply) { privateDirectory(join(project.room, "launchers")); atomicWrite(path, script, 0o700); }
  return { ok: true, applied: apply, path, script, member_id: member.id, resumes_exact_session: true,
    launch_argv: [path], reception_verified: false,
    requirement: "Exit the existing Claude client, then run this launcher in a user terminal to restore the exact session. Claude may require development-channel and MCP consent on launch; account and organization restrictions still apply." };
}
export async function launchClaude(project: Project, member?: Member): Promise<number> {
  requireThat(process.stdin.isTTY && process.stdout.isTTY && !process.env.CODEX_THREAD_ID && !process.env.CLAUDECODE,
    "E_HOST_ACTION", "Run the prepared launcher in the user's terminal; an agent must not start a nested or replacement business session");
  requireThat(!uninstalled(project) && existsSync(join(project.room, "agentchat.js")), "E_CONFIG", "Install this project before launching Claude");
  const bin = Bun.which("claude"); requireThat(bin, "E_HOST", "Claude Code is not available on PATH");
  const version = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
  requireThat(version.status === 0, "E_HOST", "Cannot inspect the Claude Code executable");
  const launch = createLaunch(project, member?.session_ref ?? null, version.stdout.trim());
  const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
  for (const key of ["CODEX_THREAD_ID", "AGENTCHAT_CLAUDE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_AGENT_ID", "AGENTCHAT_SUBAGENT"]) delete env[key];
  try {
    const path = join(project.room, "launches", `${launch.binding.id}.mcp.json`);
    writeJson(path, { mcpServers: { agentchat: { command: process.execPath,
      args: [join(project.room, "agentchat.js"), "--project", project.root, "notify", "claude-channel"], env: launch.env } } });
    const child = Bun.spawn([bin, ...(member ? ["--resume", member.session_ref!] : []), "--mcp-config", path,
      "--dangerously-load-development-channels", "server:agentchat"], { cwd: project.root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    try { launch.attachHost(child.pid); }
    catch (error) { child.kill("SIGTERM"); await child.exited; throw error; }
    const stop = (signal: NodeJS.Signals) => child.kill(signal);
    const interrupt = () => stop("SIGINT"), terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    try { return await child.exited; }
    finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
  } finally { launch.close(); }
}
