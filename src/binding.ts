import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { privateDirectory, readJson, writeJson } from "./files.ts";
import { sessionId, UUID } from "./identity.ts";
import { requireThat } from "./errors.ts";
import { tryLock } from "./lock.ts";
import type { Project } from "./types.ts";
import { integrationDir } from "./project.ts";

export interface LaunchBinding {
  id: string; token: string; project: string; room: string; createdAt: number;
  expectedSession: string | null; hostVersion: string;
  hostPid?: number;
  status: "pending" | "bound" | "ended" | "invalid";
  session?: string; boundAt?: number; endedAt?: number; reason?: string;
}
export function bindingPath(project: Project, id: string): string {
  requireThat(UUID.test(id), "E_BINDING", "Invalid launch identifier");
  return join(integrationDir(project), "launches", `${id}.json`);
}
function livePath(project: Project, id: string): string { return bindingPath(project, id) + ".live.lock"; }
export function createLaunch(project: Project, expectedSession: string | null, hostVersion: string) {
  if (expectedSession) sessionId(expectedSession);
  privateDirectory(join(integrationDir(project), "launches"));
  const binding: LaunchBinding = { id: randomUUID(), token: randomUUID(), project: project.root, room: integrationDir(project),
    createdAt: Date.now(), expectedSession, hostVersion, status: "pending" };
  const release = tryLock(livePath(project, binding.id));
  requireThat(release, "E_BUSY", "Cannot own this Claude launch");
  try { writeJson(bindingPath(project, binding.id), binding); }
  catch (error) { release(); throw error; }
  return { binding, env: { AGENTCHAT_LAUNCH_ID: binding.id, AGENTCHAT_LAUNCH_TOKEN: binding.token },
    attachHost: (pid: number) => {
      requireThat(Number.isSafeInteger(pid) && pid > 1, "E_BINDING", "Invalid native Claude process");
      const current = readJson<LaunchBinding>(bindingPath(project, binding.id));
      requireThat(current?.status === "pending" && !current.hostPid, "E_BINDING", "This launch already has a native client");
      writeJson(bindingPath(project, binding.id), { ...current, hostPid: pid });
    },
    close: () => {
      try {
        const current = readJson<LaunchBinding>(bindingPath(project, binding.id));
        if (current && current.status !== "invalid") writeJson(bindingPath(project, binding.id), { ...current, status: "ended", endedAt: Date.now() });
      } finally { release(); }
    } };
}
export function requireHostProcess(binding: LaunchBinding): void {
  requireThat(binding.hostPid && binding.hostPid === process.ppid, "E_BINDING", "This hook or Channel is not a direct child of the native Claude client that owns this launch; copied MCP configurations cannot be reused");
}
export async function waitForLaunchHost(project: Project, env: NodeJS.ProcessEnv): Promise<void> {
  if (!env.AGENTCHAT_LAUNCH_ID && !env.AGENTCHAT_LAUNCH_TOKEN) return;
  const deadline = Date.now() + 3000;
  while (!readLaunch(project, env).hostPid) {
    requireThat(Date.now() < deadline, "E_BINDING", "Launcher did not register its native Claude process");
    await Bun.sleep(10);
  }
}
export function readLaunch(project: Project, env: NodeJS.ProcessEnv, allowEnded = false): LaunchBinding {
  const id = env.AGENTCHAT_LAUNCH_ID, token = env.AGENTCHAT_LAUNCH_TOKEN;
  requireThat(id && token && UUID.test(id) && UUID.test(token), "E_BINDING", "Channel needs its own live AgentChat launch; use the prepared Claude launcher");
  const binding = readJson<LaunchBinding>(bindingPath(project, id));
  requireThat(binding && binding.id === id && binding.token === token && binding.project === project.root && binding.room === integrationDir(project),
    "E_BINDING", "Launch context belongs to another launch or project");
  const release = tryLock(livePath(project, id), false);
  if (release) { release(); requireThat(false, "E_BINDING", "Claude launcher is no longer running; old bindings cannot be reused"); }
  requireThat(binding.status === "pending" || binding.status === "bound" || (allowEnded && binding.status === "ended"), "E_BINDING", binding.reason ?? "Claude launch has ended");
  return binding;
}
export function bindLaunch(project: Project, env: NodeJS.ProcessEnv, session: string, register?: () => void): LaunchBinding | null {
  if (!env.AGENTCHAT_LAUNCH_ID && !env.AGENTCHAT_LAUNCH_TOKEN) return null;
  const current = readLaunch(project, env);
  const release = tryLock(bindingPath(project, current.id) + ".bind.lock");
  requireThat(release, "E_BUSY", "Another hook is binding this Claude launch");
  try {
    const value = readLaunch(project, env);
    requireHostProcess(value);
    if ((value.expectedSession && value.expectedSession !== session) || (value.session && value.session !== session)) {
      writeJson(bindingPath(project, value.id), { ...value, status: "invalid", reason: "Native session changed; relaunch instead of reusing another session's receiver" });
      requireThat(false, "E_BINDING", "Native session differs from this exact Claude launch");
    }
    register?.();
    const bound: LaunchBinding = { ...value, status: "bound", session: sessionId(session), boundAt: value.boundAt ?? Date.now() };
    writeJson(bindingPath(project, value.id), bound);
    return bound;
  } finally { release(); }
}
export function endLaunch(project: Project, env: NodeJS.ProcessEnv, session: string): void {
  if (!env.AGENTCHAT_LAUNCH_ID && !env.AGENTCHAT_LAUNCH_TOKEN) return;
  const value = readLaunch(project, env);
  requireHostProcess(value);
  requireThat(value.session === session, "E_BINDING", "SessionEnd belongs to another Claude launch");
  writeJson(bindingPath(project, value.id), { ...value, status: "ended", endedAt: Date.now() });
}
