import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { integrationDir, discoverProject } from "./project.ts";
import { sessionId } from "./identity.ts";
import { readJson, writeJson } from "./files.ts";
import { requireThat } from "./errors.ts";
import { localPidDomain } from "./presence.ts";
import type { PeerBinding } from "./claude-peer.ts";
import type { Project } from "./types.ts";

export interface NativeInstance { session: string; pid: number; procStart: string; pidDomain?: string; metadataPath?: string }
export interface Ancestor { pid: number; ppid: number; procStart: string; executable?: string }
export interface NativeLifecycle {
  schema: 1; runtime: "claude"; session: string; instance: NativeInstance | null; active: boolean | null;
  startedAt?: number; endedAt?: number; source?: "native_hook" | "validated_binding";
  unresolved?: { event: "SessionStart" | "SessionEnd"; at: number; reason: "provenance_unverified" | "stale_native_instance" | "ambiguous_native_session" | "reception_unavailable" };
}
const normalized = (value: string) => value.trim().replace(/\s+/g, " ");
function lifecyclePath(project: Project, session: string): string {
  return join(integrationDir(project), "native-sessions", `claude-${sessionId(session)}.json`);
}
export function sameNativeInstance(a: NativeInstance, b: NativeInstance): boolean {
  return a.session === b.session && a.pid === b.pid && normalized(a.procStart) === normalized(b.procStart)
    && (!a.pidDomain || !b.pidDomain || a.pidDomain === b.pidDomain);
}
function instanceRecord(value: NativeInstance): NativeInstance {
  return { session: value.session, pid: value.pid, procStart: normalized(value.procStart),
    ...(value.pidDomain ? { pidDomain: value.pidDomain } : {}), ...(value.metadataPath ? { metadataPath: value.metadataPath } : {}) };
}
export function nativeLifecycle(project: Project, session: string): NativeLifecycle | null {
  const value = readJson<NativeLifecycle>(lifecyclePath(project, session));
  requireThat(!value || value.schema === 1 && value.runtime === "claude" && value.session === session
    && (value.active === null || typeof value.active === "boolean") && (value.instance === null && value.active === null || value.instance && value.instance.session === session
      && Number.isSafeInteger(value.instance.pid) && value.instance.pid > 1 && typeof value.instance.procStart === "string"
      && (!value.instance.pidDomain || typeof value.instance.pidDomain === "string")), "E_CONFIG", "Invalid native lifecycle observation");
  return value;
}
// All mutation helpers are called under the same per-runtime/session selection
// lock as start/end, join, repair and dispatch. Never nest another session lock.
export function activateNative(project: Project, instance: NativeInstance, source: NativeLifecycle["source"]): void {
  const old = nativeLifecycle(project, instance.session), same = old?.instance && sameNativeInstance(old.instance, instance);
  writeJson(lifecyclePath(project, instance.session), { schema: 1, runtime: "claude", session: instance.session, instance: instanceRecord(instance),
    active: true, startedAt: same && old.active ? old.startedAt : Date.now(), source } satisfies NativeLifecycle);
}
export function unresolvedNative(project: Project, session: string, event: "SessionStart" | "SessionEnd", reason: NonNullable<NativeLifecycle["unresolved"]>["reason"]): void {
  const old = nativeLifecycle(project, session);
  writeJson(lifecyclePath(project, session), { ...(old ?? { schema: 1, runtime: "claude", session, instance: null, active: null }),
    unresolved: { event, reason, at: Date.now() } } satisfies NativeLifecycle);
}
export function endNative(project: Project, session: string, owner: NativeInstance | null, binding: PeerBinding | null): boolean {
  const previous = nativeLifecycle(project, session), current = binding ?? previous?.instance;
  if (!owner || !current) { unresolvedNative(project, session, "SessionEnd", "provenance_unverified"); return false; }
  if (!sameNativeInstance(current, owner) || previous?.instance && !sameNativeInstance(previous.instance, owner)) {
    unresolvedNative(project, session, "SessionEnd", "stale_native_instance"); return false;
  }
  writeJson(lifecyclePath(project, session), { schema: 1, runtime: "claude", session, instance: instanceRecord(owner), active: false,
    startedAt: previous?.startedAt, endedAt: previous?.endedAt ?? Date.now(), source: previous?.source ?? "native_hook" } satisfies NativeLifecycle);
  return true;
}
export function nativeEnded(project: Project, binding: PeerBinding, legacyActive?: boolean): boolean {
  const current = nativeLifecycle(project, binding.session);
  if (!current?.instance || current.active === null) return legacyActive === false;
  requireThat(sameNativeInstance(current.instance, binding), "E_PEER_INSTANCE_CHANGED", "Lifecycle and receiver instances differ; explicitly repair the exact binding");
  return !current.active;
}

// Bounded ancestry, never command arguments or a shared desktop-host PID.
export function processAncestors(budgetMs = 1500): Ancestor[] {
  const deadline = performance.now() + budgetMs, result: Ancestor[] = [], seen = new Set<number>();
  for (let pid = process.ppid; pid > 1 && result.length < 10 && !seen.has(pid);) {
    seen.add(pid); const remaining = deadline - performance.now(); if (remaining < 1) return [];
    const observation = spawnSync("/bin/ps", ["-o", "ppid=,lstart=,comm=", "-p", String(pid)], { encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: Math.max(1, Math.floor(remaining)), killSignal: "SIGKILL", maxBuffer: 4096 });
    const match = /^\s*(\d+)\s+([A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.+?)\s*$/.exec(observation.stdout ?? "");
    if (observation.error || observation.status !== 0 || !match) return [];
    const ppid = Number(match[1]); result.push({ pid, ppid, procStart: normalized(match[2]!), executable: match[3]! }); pid = ppid;
  }
  return result;
}
export function hookOwner(project: Project, session: string, env: NodeJS.ProcessEnv, expected?: NativeInstance | null,
  ancestors: Ancestor[] = processAncestors()): NativeInstance | null {
  const domain = localPidDomain(); if (!domain) return null;
  const config = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"); if (!isAbsolute(config)) return null;
  const directory = join(config, "sessions");
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || process.getuid && dir.uid !== process.getuid() || (dir.mode & 0o022) !== 0) return null;
  } catch { return null; }
  for (const ancestor of ancestors) {
    // Resolve the nearest native host. A nested Claude must never borrow an
    // outer Claude's attestation merely because that PID is also an ancestor.
    if (expected?.session === session && (!expected.pidDomain || expected.pidDomain === domain)
        && ancestor.pid === expected.pid && normalized(ancestor.procStart) === normalized(expected.procStart)) return expected;
    const path = join(directory, `${ancestor.pid}.json`); let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536 || process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error("metadata_unavailable");
      const data = Buffer.alloc(65537), count = readSync(fd, data, 0, data.length, 0), after = fstatSync(fd);
      if (count !== stat.size || count > 65536 || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("metadata_unavailable");
      const value = JSON.parse(data.subarray(0, count).toString("utf8")) as Record<string, unknown>;
      if (value.pid === ancestor.pid && typeof value.procStart === "string" && normalized(value.procStart) === ancestor.procStart
          && value.kind === "interactive" && value.entrypoint === "cli") {
        if (value.sessionId !== session || value.pidDomain !== undefined && value.pidDomain !== domain || typeof value.cwd !== "string"
            || integrationDir(discoverProject(value.cwd)) !== integrationDir(project)) return null;
        return { session, pid: ancestor.pid, procStart: ancestor.procStart,
          ...(value.pidDomain === domain ? { pidDomain: domain } : {}), metadataPath: path };
      }
    } catch { /* Missing or unusable provenance never closes a current receiver. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    // Unadvertised language runtimes can themselves host Claude (npm/node,
    // Bun); do not cross one to borrow an outer process's attestation. Only
    // known shell hook shims are transparent without native metadata.
    const executable = basename(ancestor.executable ?? "").toLowerCase();
    if (!/^(?:sh|bash|zsh|dash|fish|env)$/.test(executable)) return null;
  }
  return null;
}
