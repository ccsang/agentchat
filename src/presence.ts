import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readlinkSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { integrationDir } from "./project.ts";
import { UUID } from "./identity.ts";
import type { Member, Project } from "./types.ts";

export interface Presence {
  state: "online" | "offline" | "unknown";
  observed_at: number;
  source: "claude_registry" | "none";
  scope: "native_session" | "bound_native_instance" | "recorded_registry";
  reason_code: string;
  registry?: string;
  host_reported?: { status: string; observed_at?: number };
}
export type ProcessObservation = { state: "alive"; started: string } | { state: "gone" | "unknown" };
export interface PresenceOptions {
  budgetMs?: number;
  clock?: () => number;
  domain?: string | null;
  processes?: (pids: number[], timeoutMs: number) => Map<number, ProcessObservation>;
}
interface Binding { session: string; pid: number; procStart: string; metadataPath: string; pidDomain?: string }
interface BindingSnapshot { value: Binding; path: string; file: Fingerprint; directory: Fingerprint }
interface Record { sessionId: string; pid: number; procStart: string; pidDomain?: string; status?: unknown; statusUpdatedAt?: unknown }
interface Fingerprint { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Registry { records: Record[]; files: Map<string, Fingerprint>; fingerprint: Fingerprint; reason?: string }
const MAX_FILE = 65536, MAX_BYTES = 2 * 1024 * 1024, MAX_ENTRIES = 4096, MAX_RECORDS = 1000, MAX_PIDS = 1000;
const normalized = (s: string) => s.trim().replace(/\s+/g, " ");
const validStart = (s: unknown): s is string => typeof s === "string" && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/.test(normalized(s));
const pidValid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && Number(pid) > 1 && Number(pid) <= 2147483647;
const fingerprint = (s: Fingerprint): Fingerprint => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const equal = (a: Fingerprint, b: Fingerprint) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

// Observed native metadata domain format (Claude 2.1.322). Unknown future formats
// affect only this observation, never notification eligibility or host support.
export function localPidDomain(): string | null {
  if (process.platform === "darwin") return "darwin";
  if (process.platform !== "linux") return null;
  try {
    const id = readFileSync("/etc/machine-id", "utf8").trim();
    const ns = readlinkSync("/proc/self/ns/pid");
    return /^[a-f0-9]{32}$/.test(id) && /^pid:\[\d+\]$/.test(ns) ? `linux:${id}:${ns}` : null;
  } catch { return null; }
}

export function observeProcesses(pids: number[], timeoutMs: number): Map<number, ProcessObservation> {
  const result = new Map<number, ProcessObservation>(pids.map(pid => [pid, { state: "unknown" }]));
  if (!pids.length || pids.length > MAX_PIDS || timeoutMs < 1 || !["darwin", "linux"].includes(process.platform)) return result;
  const ps = spawnSync("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
    encoding: "utf8", timeout: Math.max(1, Math.floor(timeoutMs)), killSignal: "SIGKILL", maxBuffer: 128 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (ps.error || ps.signal || ![0, 1].includes(ps.status ?? -1) || ps.stderr.trim()) return result;
  const seen = new Map<number, string>();
  for (const line of ps.stdout.split("\n").filter(line => line.trim())) {
    const match = /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/.exec(line);
    if (!match || !result.has(Number(match[1])) || seen.has(Number(match[1]))) return result;
    seen.set(Number(match[1]), normalized(match[2]!));
  }
  for (const pid of pids) {
    const started = seen.get(pid);
    if (started) result.set(pid, { state: "alive", started });
    else {
      // ps absence alone is not enough: ESRCH is positive local-kernel evidence.
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") result.set(pid, { state: "gone" }); }
    }
  }
  return result;
}

export function observePresence(project: Project, members: Member[], options: PresenceOptions = {}): Map<string, Presence> {
  const clock = options.clock ?? (() => performance.now()), deadline = clock() + (options.budgetMs ?? 1500);
  const observedAt = Date.now(), domain = options.domain === undefined ? members.some(member => member.runtime === "claude") ? localPidDomain() : null : options.domain;
  let bytes = 0;
  const budget = () => { if (clock() >= deadline || bytes > MAX_BYTES) throw new Error("observation_budget_exceeded"); };
  const ownedDir = (path: string, privateOnly = false) => {
    budget();
    const s = lstatSync(path);
    if (!s.isDirectory() || s.isSymbolicLink() || process.getuid && s.uid !== process.getuid() ||
        (s.mode & (privateOnly ? 0o077 : 0o022)) !== 0) throw new Error("metadata_unavailable");
    return fingerprint(s);
  };
  // Open a bounded regular descriptor, never a credential file, symlink or FIFO.
  const json = (path: string, privateOnly = false): { value: unknown; file: Fingerprint } => {
    budget();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || process.getuid && before.uid !== process.getuid() ||
          (before.mode & (privateOnly ? 0o077 : 0o022)) !== 0 || before.size > MAX_FILE) throw new Error("metadata_unavailable");
      const data = Buffer.alloc(Math.min(before.size + 1, MAX_FILE + 1));
      let count = 0;
      while (count < data.length) {
        budget(); const read = readSync(fd, data, count, data.length - count, null);
        if (!read) break; count += read;
      }
      bytes += count; budget();
      const after = fstatSync(fd);
      if (count !== before.size || !equal(fingerprint(before), fingerprint(after))) throw new Error("snapshot_changed");
      return { value: JSON.parse(data.subarray(0, count).toString("utf8")), file: fingerprint(after) };
    } finally { closeSync(fd); }
  };
  const reason = (error: unknown) => error instanceof Error && ["observation_budget_exceeded", "registry_record_invalid", "registry_snapshot_changed", "binding_snapshot_changed"].includes(error.message)
    ? error.message : "metadata_unavailable";
  const unknown = (code: string, registry?: string): Presence => ({ state: "unknown", observed_at: observedAt,
    source: registry ? "claude_registry" : "none", scope: registry ? "recorded_registry" : "native_session",
    reason_code: code, ...(registry ? { registry } : {}) });
  const snapshot = () => {
    const output = new Map<string, Presence>(), bindings = new Map<string, BindingSnapshot>(), registries = new Map<string, Registry>();
    const bindingCache = new Map<string, BindingSnapshot | null>();
    const binding = (member: Member): BindingSnapshot | null => {
      if (!member.session_ref || !UUID.test(member.session_ref) || !/^m_[a-f0-9-]{36}$/.test(member.id)) throw new Error("metadata_unavailable");
      if (bindingCache.has(member.session_ref)) return bindingCache.get(member.session_ref)!;
      ownedDir(integrationDir(project), true);
      let snapshot: { path: string; value: unknown; file: Fingerprint; directory: Fingerprint } | null = null;
      for (const path of [join(integrationDir(project), "socket-sessions", `${member.session_ref}.json`), join(project.room, "socket-bindings", `${member.id}.json`)]) {
        try { const directory = ownedDir(dirname(path), true); snapshot = { path, ...json(path, true), directory }; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!snapshot) { bindingCache.set(member.session_ref, null); return null; }
      const b = snapshot.value as Partial<Binding>;
      if (!b || b.session !== member.session_ref || !pidValid(b.pid) || !validStart(b.procStart) ||
          typeof b.metadataPath !== "string" || !isAbsolute(b.metadataPath) || basename(b.metadataPath) !== `${b.pid}.json` ||
          b.pidDomain !== undefined && typeof b.pidDomain !== "string") throw new Error("metadata_unavailable");
      const result = { ...snapshot, value: b as Binding };
      bindingCache.set(member.session_ref, result); return result;
    };
    for (const member of members) {
      if (member.runtime !== "claude") { output.set(member.id, unknown(member.runtime === "generic" ? "manual_member" : "no_native_lifecycle_signal")); continue; }
      try {
        budget(); const saved = binding(member);
        if (!saved) { output.set(member.id, unknown("no_recorded_binding")); continue; }
        bindings.set(member.id, saved); const b = saved.value;
        const dir = dirname(b.metadataPath);
        if (registries.has(dir)) continue;
        const registry: Registry = { records: [], files: new Map(), fingerprint: ownedDir(dir) };
        registries.set(dir, registry);
        try {
          const directory = opendirSync(dir); let entries = 0;
          try {
            for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
              budget(); if (++entries > MAX_ENTRIES) throw new Error("observation_budget_exceeded");
              if (!/^[1-9]\d*\.json$/.test(entry.name)) continue;
              if (registry.records.length >= MAX_RECORDS) throw new Error("observation_budget_exceeded");
              const path = join(dir, entry.name), record = json(path), v = record.value as Partial<Record>;
              if (!v || !pidValid(v.pid) || basename(path) !== `${v.pid}.json` || typeof v.sessionId !== "string" || !UUID.test(v.sessionId) ||
                  !validStart(v.procStart) || v.pidDomain !== undefined && typeof v.pidDomain !== "string") throw new Error("registry_record_invalid");
              registry.records.push(v as Record); registry.files.set(path, record.file);
            }
          } finally { directory.closeSync(); }
        } catch (error) { registry.reason = error instanceof SyntaxError ? "registry_record_invalid"
          : (error as NodeJS.ErrnoException).code === "ENOENT" ? "registry_snapshot_changed" : reason(error); }
      } catch (error) { output.set(member.id, unknown(reason(error))); }
    }
    const pids = new Set<number>();
    for (const { value: b } of bindings.values()) {
      const registry = registries.get(dirname(b.metadataPath));
      if (!registry || registry.reason) continue;
      const records = registry.records.filter(record => record.sessionId === b.session);
      // Do not even interpret a native PID until its namespace is established.
      if (!domain || b.pidDomain !== undefined && b.pidDomain !== domain ||
          !records.length && b.pidDomain !== domain || records.some(record => record.pidDomain !== domain)) continue;
      pids.add(b.pid);
      for (const record of records) pids.add(record.pid);
    }
    let processes = new Map<number, ProcessObservation>(), processReason = "process_observation_unavailable";
    try {
      budget();
      if (pids.size > MAX_PIDS) throw new Error("observation_budget_exceeded");
      if (pids.size) processes = (options.processes ?? observeProcesses)([...pids], deadline - clock());
      budget();
    } catch (error) { processReason = reason(error) === "observation_budget_exceeded" ? "observation_budget_exceeded" : processReason; processes.clear(); }
    for (const [dir, registry] of registries) {
      if (registry.reason) continue;
      try {
        if (!equal(registry.fingerprint, ownedDir(dir))) throw new Error("registry_snapshot_changed");
        for (const [path, expected] of registry.files) {
          budget(); if (!equal(expected, fingerprint(lstatSync(path)))) throw new Error("registry_snapshot_changed");
        }
      } catch (error) { registry.reason = reason(error); }
    }
    for (const [id, saved] of bindings) {
      const b = saved.value;
      const dir = dirname(b.metadataPath), registry = registries.get(dir);
      if (!registry || registry.reason) { output.set(id, unknown(registry?.reason ?? "metadata_unavailable", dir)); continue; }
      try {
        budget();
        if (!equal(saved.directory, ownedDir(dirname(saved.path), true)) || !equal(saved.file, fingerprint(lstatSync(saved.path)))) throw new Error("binding_snapshot_changed");
      } catch (error) { output.set(id, unknown(reason(error), dir)); continue; }
      const records = registry.records.filter(v => v.sessionId === b.session);
      if (!records.length && (!domain || b.pidDomain !== domain)) { output.set(id, unknown("no_registry_record_namespace_unverified", dir)); continue; }
      if (!domain || b.pidDomain !== undefined && b.pidDomain !== domain || records.some(v => v.pidDomain !== domain)) {
        output.set(id, unknown("pid_namespace_unverified", dir)); continue;
      }
      const current = processes.get(b.pid);
      if (!current || current.state === "unknown" || records.some(v => !processes.has(v.pid) || processes.get(v.pid)?.state === "unknown")) {
        output.set(id, unknown(processReason, dir)); continue;
      }
      const live = records.filter(v => { const p = processes.get(v.pid); return p?.state === "alive" && p.started === normalized(v.procStart); });
      if (live.length > 1) { output.set(id, unknown("ambiguous_native_session", dir)); continue; }
      const v = live[0];
      if (v && v.pid === b.pid && normalized(v.procStart) === normalized(b.procStart)) {
        const hostReported = typeof v.status === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(v.status)
          ? { status: v.status, ...(typeof v.statusUpdatedAt === "number" && Number.isSafeInteger(v.statusUpdatedAt) && v.statusUpdatedAt > 0 ? { observed_at: v.statusUpdatedAt } : {}) } : undefined;
        output.set(id, { state: "online", observed_at: observedAt, source: "claude_registry", scope: "bound_native_instance", registry: dir,
          reason_code: "exact_native_instance_observed", ...(hostReported ? { host_reported: hostReported } : {}) });
      } else if (!live.length && (current.state === "gone" || current.state === "alive" && (current.started !== normalized(b.procStart)
          || registry.records.some(record => record.pid === b.pid && record.sessionId !== b.session && record.pidDomain === domain && normalized(record.procStart) === current.started)))) {
        output.set(id, { state: "offline", observed_at: observedAt, source: "claude_registry", scope: "recorded_registry", registry: dir,
          reason_code: "no_live_instance_in_recorded_registry" });
      } else output.set(id, unknown(v ? "live_replacement_observed" : "recorded_instance_unresolved", dir));
    }
    return output;
  };
  const output = snapshot();
  // Retry one changing snapshot within the original command's time/byte budget.
  return [...output.values()].some(value => ["registry_snapshot_changed", "binding_snapshot_changed"].includes(value.reason_code)) && clock() < deadline
    ? snapshot() : output;
}
