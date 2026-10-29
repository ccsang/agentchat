import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import type { Project } from "./types.ts";

// A build-time constant: older supported Bun versions do not expose isStandaloneExecutable.
declare const AGENTCHAT_STANDALONE: boolean | undefined;
export const standalone = typeof AGENTCHAT_STANDALONE !== "undefined" && AGENTCHAT_STANDALONE;

export function installCommand(project: Project): string[] {
  const executable = realpathSync(process.execPath);
  return standalone ? [executable] : [executable, join(project.room, "agentchat.js")];
}

export function installedCommand(project: Project): string[] {
  const saved = readJson<{ command?: unknown; interpreter?: string; tool?: string }>(join(project.room, "installed.json"));
  const command = saved?.command ?? (saved?.interpreter && saved.tool ? [saved.interpreter, saved.tool] : installCommand(project));
  requireThat(Array.isArray(command) && command.length >= 1 && command.length <= 2 && command.every(value => typeof value === "string" && isAbsolute(value)),
    "E_CONFIG", "Invalid installed AgentChat executable; reinstall this project");
  return command as string[];
}

export function installedToolExists(project: Project): boolean {
  return installedCommand(project).every(path => existsSync(path));
}
