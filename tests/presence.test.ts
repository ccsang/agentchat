import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { cli, fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { writeJson } from "../src/files.ts";
import { describeMembers, leaveSelectedRoom, roomProject, selectRoom, createRoom } from "../src/rooms.ts";
import { localPidDomain, observePresence, observeProcesses } from "../src/presence.ts";
import type { ProcessObservation } from "../src/presence.ts";
import { processStart } from "../src/claude-peer.ts";
import type { Member } from "../src/types.ts";

let f: ReturnType<typeof fixture>, store: Store, member: Member, registry: string;
const started = "Thu Jan  1 00:00:00 2026".replace(/\s+/g, " ");
const processes = (entries: [number, ProcessObservation][] = [[101, { state: "alive", started }]]) => () => new Map(entries);
function metadata(m = member, pid = 101, extra: object = {}) {
  writeFileSync(join(registry, `${pid}.json`), JSON.stringify({ sessionId: m.session_ref, pid, procStart: started,
    pidDomain: "fixture-local", version: "0.0.0", kind: "not-a-native-client", peerProtocol: 999, ...extra }), { mode: 0o600 });
}
function bind(m = member, pid = 101, extra: object = {}) {
  writeJson(join(f.project.room, "socket-sessions", `${m.session_ref}.json`), { session: m.session_ref, pid,
    procStart: started, metadataPath: join(registry, `${pid}.json`), instance: "0".repeat(64), enabled: false, ...extra });
}
function snapshot(root: string): unknown {
  const walk = (path: string): unknown => {
    const stat = lstatSync(path);
    return { mode: stat.mode, size: stat.size, mtime: stat.mtimeMs,
      data: stat.isDirectory() ? readdirSync(path).sort().map(name => [name, walk(join(path, name))])
        : stat.isSymbolicLink() ? "symlink" : createHash("sha256").update(readFileSync(path)).digest("hex") };
  };
  return walk(root);
}
beforeEach(() => {
  f = fixture(); store = new Store(f.project.room, { create: true }); member = store.join(nativeIdentity("claude"));
  registry = join(f.root, "custom-claude", "sessions"); mkdirSync(registry, { recursive: true, mode: 0o700 });
  bind(); metadata();
});
afterEach(() => { store.close(); f.cleanup(); });
const observe = (extra: Parameters<typeof observePresence>[2] = {}) => observePresence(f.project, [member],
  { domain: "fixture-local", processes: processes(), ...extra }).get(member.id)!;

test("presence observes an exact instance independently of receiver eligibility without reading keys or opening sockets", () => {
  metadata(member, 101, { status: "offline", statusUpdatedAt: 1, privateField: "private-sentinel" });
  writeFileSync(join(registry, "101.not-a-credential.key"), "not JSON and must never be opened", { mode: 0o600 });
  const before = snapshot(f.root), value = observe();
  expect(value).toMatchObject({ state: "online", scope: "bound_native_instance", source: "claude_registry",
    reason_code: "exact_native_instance_observed", registry, host_reported: { status: "offline", observed_at: 1 } });
  expect(JSON.stringify(value)).not.toContain("private-sentinel");
  expect(snapshot(f.root)).toEqual(before);
});
test("Codex proof, legacy active and manual registration do not establish presence", () => {
  const codex = store.join(nativeIdentity()), generic = store.join({ runtime: "generic", session: null }, "manual");
  writeJson(join(f.project.room, "sessions", `${codex.session_ref}.json`), { active: true, proof: { nonce: "old" } });
  const result = observePresence(f.project, [codex, generic]);
  expect(result.get(codex.id)).toMatchObject({ state: "unknown", reason_code: "no_native_lifecycle_signal" });
  expect(result.get(generic.id)).toMatchObject({ state: "unknown", reason_code: "manual_member" });
  writeJson(join(f.project.room, "sessions", `${member.session_ref}.json`), { active: false });
  expect(observe().state).toBe("online");
});
test.each(["gone", "reused"])("a %s recorded process is offline only within a complete local registry", kind => {
  const result = observe({ processes: processes([[101, kind === "gone" ? { state: "gone" } : { state: "alive", started: "another start" }]]) });
  expect(result).toMatchObject({ state: "offline", scope: "recorded_registry", registry, reason_code: "no_live_instance_in_recorded_registry" });
});
test.each([undefined, "remote-host", "linux:other-machine:pid:[99]"])("an unverified PID namespace stays unknown (%s)", pidDomain => {
  metadata(member, 101, { pidDomain });
  let called = false;
  expect(observe({ processes: () => { called = true; return new Map(); } }).reason_code).toBe("pid_namespace_unverified");
  expect(called).toBe(false);
});
test("missing evidence, incomplete metadata and failed process observations are unknown rather than offline", () => {
  writeFileSync(join(registry, "102.json"), "{incomplete", { mode: 0o600 });
  expect(observe({ processes: processes([[101, { state: "gone" }]]) }).state).toBe("unknown");
  writeFileSync(join(registry, "102.json"), JSON.stringify({ sessionId: randomUUID(), pid: 102, procStart: started, pidDomain: "fixture-local" }));
  expect(observe({ processes: () => { throw new Error("private-error"); } })).toMatchObject({ state: "unknown", reason_code: "process_observation_unavailable" });
  expect(JSON.stringify(observe({ processes: () => { throw new Error("private-error"); } }))).not.toContain("private-error");
});
test("a live replacement or multiple live instances do not silently replace a saved binding", () => {
  metadata(member, 102);
  expect(observe({ processes: processes([[101, { state: "gone" }], [102, { state: "alive", started }]]) })).toMatchObject({ state: "unknown", reason_code: "live_replacement_observed" });
  expect(observe({ processes: processes([[101, { state: "alive", started }], [102, { state: "alive", started }]]) })).toMatchObject({ state: "unknown", reason_code: "ambiguous_native_session" });
});
test("linked metadata makes the registry observation incomplete", () => {
  symlinkSync(join(f.root, "not-a-native-file"), join(registry, "102.json"));
  expect(observe().state).toBe("unknown");
});
test("process checks are batched across members and the command budget is explicit", () => {
  const second = store.join(nativeIdentity("claude")); bind(second, 102); metadata(second, 102);
  let calls = 0;
  const result = observePresence(f.project, [member, second], { domain: "fixture-local", processes: pids => {
    calls++; expect(pids.sort()).toEqual([101, 102]); return new Map(pids.map(pid => [pid, { state: "alive", started }]));
  } });
  expect(calls).toBe(1); expect(result.get(second.id)?.state).toBe("online");
  let ticks = 0;
  const exhausted = observePresence(f.project, [member, second], { clock: () => ticks++, budgetMs: 1, domain: "fixture-local" });
  expect([...exhausted.values()].every(value => value.state === "unknown" && value.reason_code === "observation_budget_exceeded")).toBe(true);
});
test("selection display handles room switches, explicit leave, generic and corrupt peer selections", () => {
  const codex = store.join(nativeIdentity()), generic = store.join({ runtime: "generic", session: null }, "manual");
  createRoom(f.project, "review"); selectRoom(roomProject(f.project, "review"), { runtime: codex.runtime, session: codex.session_ref });
  const selected = describeMembers(f.project, [codex, generic]);
  expect(selected[0]).toMatchObject({ membership: "joined", selected_room: "review", selected_here: false });
  expect(selected[1]).toMatchObject({ selected_room: null, selected_here: null, selection_reason_code: "no_native_selection" });
  selectRoom(f.project, { runtime: codex.runtime, session: codex.session_ref });
  leaveSelectedRoom(f.project, { runtime: codex.runtime, session: codex.session_ref });
  expect(describeMembers(f.project, [codex])[0]).toMatchObject({ membership: "left", selected_room: null, selected_here: false });
  writeFileSync(join(f.project.room, "room-selections", `${codex.runtime}-${codex.session_ref}.json`), "broken");
  const members = describeMembers(f.project, [codex, member]);
  expect(members[0]).toMatchObject({ membership: null, selected_room: null, selected_here: null, selection_reason_code: "selection_unavailable" });
  expect(members[1]?.membership).toBe("joined");
  // A display error never permits a send from the corrupt selection.
  const env = testEnv({ CODEX_THREAD_ID: codex.session_ref! });
  expect(cli(f.root, ["--room", "default", "send", "--text", "must fail"], env).status).not.toBe(0);
  const listed = cli(f.root, ["--room", "default", "members"], env);
  expect(listed.status).toBe(0);
  expect(listed.data.members.find((value: { id: string }) => value.id === codex.id).membership).toBeNull();
  const diagnosed = cli(f.root, ["--room", "default", "--as", codex.id, "doctor"],
    { ...env, AGENTCHAT_CODEX_BIN: join(f.root, "absent-codex") });
  expect(diagnosed.status).toBe(0); expect(diagnosed.data.joined).toBeNull();
});
test("members, doctor and room list leave read-only runtime and database snapshots unchanged", () => {
  const codex = store.join(nativeIdentity()), env = testEnv({ CODEX_THREAD_ID: codex.session_ref!, AGENTCHAT_CODEX_BIN: join(f.root, "absent-codex") });
  store.close();
  chmodSync(join(f.project.room, "chat.db"), 0o400); chmodSync(f.project.room, 0o500);
  const before = snapshot(f.root);
  for (const args of [["members"], ["doctor"], ["room", "list"]]) {
    const result = cli(f.root, args, env); expect(result.status).toBe(0); expect(snapshot(f.root)).toEqual(before);
  }
  chmodSync(f.project.room, 0o700); chmodSync(join(f.project.room, "chat.db"), 0o600);
  store = new Store(f.project.room);
});
test.each([false, true])("doctor separates presence from receiver eligibility (enabled=%s)", enabled => {
  unlinkSync(join(registry, "101.json"));
  metadata(member, process.pid, { procStart: processStart(process.pid), pidDomain: localPidDomain() });
  bind(member, process.pid, { procStart: processStart(process.pid), enabled });
  const result = cli(f.root, ["--as", member.id, "doctor"], testEnv());
  expect(result.status).toBe(0); expect(result.data.presence.state).toBe("online");
  expect(result.data.presence.registry).toBe(registry); expect(result.data.reception.state).toBe(enabled ? "inactive" : "disabled");
  expect(result.data.member.selected_here).toBe(true);
});
test("read-only Store refuses WAL before it can create SHM or mutate any database sidecar", () => {
  store.close();
  const db = new Database(join(f.project.room, "chat.db")); db.exec("PRAGMA journal_mode=WAL;"); db.close();
  const before = snapshot(f.root);
  expect(() => new Store(f.project.room, { readonly: true })).toThrow("Expected SQLite rollback journal mode");
  expect(snapshot(f.root)).toEqual(before);
  const restored = new Database(join(f.project.room, "chat.db")); restored.exec("PRAGMA journal_mode=DELETE;"); restored.close();
  store = new Store(f.project.room);
});
test("local process snapshots distinguish a live test process from a positively exited child", () => {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  expect(child.status).toBe(0);
  const result = observeProcesses([process.pid, child.pid!], 1000);
  expect(result.get(process.pid)?.state).toBe("alive"); expect(result.get(child.pid!)?.state).toBe("gone");
  expect(observeProcesses([process.pid], 0).get(process.pid)?.state).toBe("unknown");
});

test("oversized or malformed process identity cannot establish presence", () => {
  metadata(member, 101, { procStart: "not a process start" });
  expect(observe().state).toBe("unknown");
  metadata(member, 101, { ignored: "x".repeat(65536) });
  expect(observe().state).toBe("unknown");
});
test("concurrent native metadata replacement invalidates the snapshot", () => {
  const value = observe({ processes: pids => {
    metadata(member, 101, { status: "changed-during-observation" });
    return new Map(pids.map(pid => [pid, { state: "alive", started }]));
  } });
  expect(value.state).toBe("unknown");
});
test("a binding changed during observation cannot report the old instance as online", () => {
  const value = observe({ processes: pids => {
    bind(member, 102);
    return new Map(pids.map(pid => [pid, { state: "alive", started }]));
  } });
  expect(value).toMatchObject({ state: "unknown", reason_code: "binding_snapshot_changed" });
});
test("a one-time metadata update is retried once within the command budget", () => {
  let calls = 0;
  const value = observe({ processes: pids => {
    if (++calls === 1) metadata(member, 101, { status: "busy" });
    return new Map(pids.map(pid => [pid, { state: "alive", started }]));
  } });
  expect(calls).toBe(2); expect(value.state).toBe("online");
});
test("deleted legacy metadata cannot establish a PID namespace from a binding without recorded domain evidence", () => {
  unlinkSync(join(registry, "101.json")); let called = false;
  expect(observe({ processes: () => { called = true; return new Map(); } })).toMatchObject({ state: "unknown", reason_code: "no_registry_record_namespace_unverified" });
  expect(called).toBe(false);
});
test("a newly attested binding retains namespace evidence after clean native metadata deletion", () => {
  bind(member, 101, { pidDomain: "fixture-local" }); unlinkSync(join(registry, "101.json"));
  expect(observe({ processes: processes([[101, { state: "gone" }]]) })).toMatchObject({ state: "offline", scope: "recorded_registry" });
  expect(observe({ processes: processes([[101, { state: "alive", started }]]) })).toMatchObject({ state: "unknown", reason_code: "recorded_instance_unresolved" });
  bind(member, 101, { pidDomain: "remote-host" }); let called = false;
  expect(observe({ processes: () => { called = true; return new Map(); } }).state).toBe("unknown"); expect(called).toBe(false);
});
test("clear can end the recorded session while its native process remains alive with a different exact session", () => {
  const next = store.join(nativeIdentity("claude")); bind(member, 101, { pidDomain: "fixture-local" }); metadata(next);
  expect(observe()).toMatchObject({ state: "offline", scope: "recorded_registry", reason_code: "no_live_instance_in_recorded_registry" });
  metadata(); expect(observe().state).toBe("online");
});
