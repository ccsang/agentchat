import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fixture, nativeIdentity } from "./helpers.ts";
import { activateNative, endNative, hookOwner, nativeEnded, nativeLifecycle } from "../src/lifecycle.ts";
import * as lifecycle from "../src/lifecycle.ts";
import type { NativeInstance } from "../src/lifecycle.ts";
import type { PeerBinding } from "../src/claude-peer.ts";
import { Store } from "../src/store.ts";
import { applyInstall, planInstall } from "../src/install.ts";
import { endHook } from "../src/hooks.ts";
import { createRoom, roomProject, tryRoomSelectionLock } from "../src/rooms.ts";
import { dispatchSocket } from "../src/socket-adapter.ts";
import { configureSocket } from "../src/socket-state.ts";
import { localPidDomain } from "../src/presence.ts";
import { writeJson } from "../src/files.ts";
import { receiver, saveState } from "../src/runtime.ts";

let f: ReturnType<typeof fixture>, store: Store, session: string;
const started = "Thu Jan 1 00:00:00 2026";
const instance = (pid = 101): NativeInstance => ({ session, pid, procStart: started, pidDomain: localPidDomain() ?? undefined });
const binding = (pid = 101) => ({ ...instance(pid), enabled: true, version: "2.1.322", instance: "a".repeat(64), metadataPath: "/fixture/sessions/101.json",
  socketPath: "/fixture/101.sock", realSocketPath: "/fixture/101.sock", socketDev: 1, socketIno: 1, configuredAt: 1 }) satisfies PeerBinding;
beforeEach(() => { f = fixture(); store = new Store(f.project.room, { create: true }); session = nativeIdentity("claude").session!; });
afterEach(() => { store.close(); f.cleanup(); });

test("late end from an older native instance cannot close the resumed receiver in any room", () => {
  createRoom(f.project, "review"); const review = roomProject(f.project, "review"), old = binding(), current = binding(102);
  activateNative(f.project, old, "native_hook"); expect(endNative(f.project, session, old, old)).toBe(true);
  activateNative(review, current, "native_hook"); const before = nativeLifecycle(f.project, session);
  expect(endNative(f.project, session, old, current)).toBe(false);
  expect(nativeLifecycle(review, session)).toMatchObject({ active: true, instance: { pid: 102 }, startedAt: before!.startedAt,
    unresolved: { reason: "stale_native_instance" } });
  expect(nativeEnded(f.project, current, false)).toBe(false); expect(nativeEnded(review, current, false)).toBe(false);
  expect(() => nativeEnded(f.project, old, true)).toThrow("instances differ");
});
test("duplicate start/end are idempotent and an unattested event preserves the current pre-exit gate", () => {
  const current = binding(); activateNative(f.project, current, "native_hook"); const before = nativeLifecycle(f.project, session)!;
  activateNative(f.project, current, "native_hook"); expect(nativeLifecycle(f.project, session)!.startedAt).toBe(before.startedAt);
  expect(endNative(f.project, session, null, current)).toBe(false); expect(nativeEnded(f.project, current, false)).toBe(false);
  expect(endNative(f.project, session, current, current)).toBe(true); const ended = nativeLifecycle(f.project, session)!.endedAt;
  expect(nativeEnded(f.project, current, true)).toBe(true);
  expect(endNative(f.project, session, current, current)).toBe(true); expect(nativeLifecycle(f.project, session)!.endedAt).toBe(ended);
  expect(endNative(f.project, session, null, current)).toBe(false); expect(nativeEnded(f.project, current, true)).toBe(true);
});
test("legacy inactive gates remain enforced until a real binding or native start establishes the current instance", () => {
  const current = binding(); expect(nativeEnded(f.project, current, false)).toBe(true);
  expect(endNative(f.project, session, null, null)).toBe(false); expect(nativeEnded(f.project, current, false)).toBe(true);
  activateNative(f.project, current, "validated_binding"); expect(nativeEnded(f.project, current, false)).toBe(false);
});
test("native end waits on the exact session lock; dispatch/repair cannot cross a lifecycle or room change", async () => {
  applyInstall(await planInstall(f.project));
  const member = store.join({ runtime: "claude", session }), sender = store.join(nativeIdentity());
  const current = binding(); activateNative(f.project, current, "native_hook");
  writeJson(join(f.project.room, "socket-sessions", `${session}.json`), current);
  const owner = spyOn(lifecycle, "hookOwner").mockReturnValue(current);
  let release = tryRoomSelectionLock(f.project, { runtime: "claude", session }); expect(release).not.toBeNull();
  try {
    store.send({ from: sender.id, to: member.id, id: "held-by-lifecycle", body: "fixture", notify: true });
    expect((await dispatchSocket(store, f.project, member)).reason).toBe("room_selection_busy");
    expect(store.message("held-by-lifecycle").notify_batch_id).toBeNull();
    expect(() => configureSocket(f.project, member, true)).toThrow("changing selection or reception");
    const ending = endHook(f.project, { session_id: session, cwd: f.root, hook_event_name: "SessionEnd" });
    await Bun.sleep(20); expect(nativeLifecycle(f.project, session)!.active).toBe(true);
    release!(); release = null; await ending;
    expect(nativeLifecycle(f.project, session)!.active).toBe(false);
  } finally { release?.(); owner.mockRestore(); }
});
test("hook provenance uses exact ancestor start and recorded namespace, never the inherited UUID alone", () => {
  const registry = join(f.root, "claude", "sessions"), path = join(registry, "101.json"); mkdirSync(registry, { recursive: true, mode: 0o700 });
  const env = { CLAUDE_CONFIG_DIR: join(f.root, "claude"), AGENTCHAT_CLAUDE_SESSION_ID: session }, current = instance();
  const parents = [{ pid: 101, ppid: 2, procStart: started }];
  writeFileSync(path, JSON.stringify({ pid: 101, sessionId: session, procStart: started, pidDomain: localPidDomain(), cwd: f.root,
    kind: "interactive", entrypoint: "cli" }), { mode: 0o600 });
  expect(hookOwner(f.project, session, env, null, parents)).toMatchObject(current);
  expect(hookOwner(f.project, session, env, null, [{ ...parents[0]!, procStart: "different" }])).toBeNull();
  unlinkSync(path); expect(hookOwner(f.project, session, env, null, parents)).toBeNull();
  expect(hookOwner(f.project, session, env, current, parents)).toMatchObject(current);
  expect(hookOwner(f.project, session, env, { ...current, pidDomain: "remote-host" }, parents)).toBeNull();
});
test.each(["claude", "node", "bun", "python", "python3.14"])("nested %s hosts cannot end an outer host's receiver by borrowing its ancestor identity", executable => {
  const registry = join(f.root, "claude", "sessions"), path = join(registry, "101.json"); mkdirSync(registry, { recursive: true, mode: 0o700 });
  const env = { CLAUDE_CONFIG_DIR: join(f.root, "claude") }, outer = instance(102);
  const parents = [101, 102].map(pid => ({ pid, ppid: pid + 1, procStart: started, executable }));
  const metadata = { pid: 101, sessionId: session, procStart: started, cwd: f.root, kind: "interactive", entrypoint: "cli" };
  writeFileSync(path, JSON.stringify(metadata), { mode: 0o600 });
  // An omitted optional pidDomain does not disable supported older hosts whose
  // own local ancestor/start is attested; it supplies no offline scope evidence.
  const inner = hookOwner(f.project, session, env, outer, parents); expect(inner?.pid).toBe(101); expect(inner?.pidDomain).toBeUndefined();
  activateNative(f.project, outer, "native_hook"); expect(endNative(f.project, session, inner, binding(102))).toBe(false);
  writeFileSync(path, JSON.stringify({ ...metadata, sessionId: nativeIdentity("claude").session }));
  expect(hookOwner(f.project, session, env, outer, parents)).toBeNull();
  unlinkSync(path); expect(hookOwner(f.project, session, env, outer, parents)).toBeNull();
});
test("an unverified hook has an exact-member repair hint without initializing another room", () => {
  const member = store.join({ runtime: "claude", session });
  saveState(f.project, { session, memberId: member.id, active: false, error: { code: "E_HOOK_PROVENANCE", reason: "fixture", at: Date.now() } });
  const status = receiver(f.project, member);
  expect(status.diagnostic).toMatchObject({ code: "E_HOOK_PROVENANCE", cause: "hook_provenance_unverified" });
  expect(status.recovery).toMatchObject({ preview_argv: [join(f.project.room, "run"), "--project", f.root, "--room", "default", "socket-config", "--to", member.id] });
});
