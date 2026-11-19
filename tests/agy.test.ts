import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, testEnv } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { applyMigration, planMigration } from "../src/migrate.ts";
import { applyInstall, planInstall } from "../src/install.ts";
import { identify } from "../src/identity.ts";
import type { Ancestor } from "../src/lifecycle.ts";
import { AGY_TURN, agyHook, agyMode, observeAgyLocked } from "../src/agy.ts";
import { notifyMember } from "../src/notify.ts";
import { receiver, pause, resume, saveState, state } from "../src/runtime.ts";
import { createRoom, leaveSelectedRoom, roomProject, selectRoom } from "../src/rooms.ts";
import { writeJson } from "../src/files.ts";

let f: ReturnType<typeof fixture>, store: Store;
let config: string | undefined;
const started = "Thu Nov 12 09:43:00 2026";
function ancestors(runtime: "agy" | "claude" | "codex", path: string = runtime): Ancestor[] { return [{ pid: 9001, ppid: 1, procStart: started, executable: path }]; }
beforeEach(async () => { f = fixture(); config = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = join(f.root, "claude-config"); store = new Store(f.project.room, { create: true }); applyMigration(planMigration(f.project)); applyInstall(await planInstall(f.project)); });
afterEach(() => { store.close(); if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = config; f.cleanup(); });
function joined() { const member = store.join({ runtime: "agy", session: randomUUID() }); observeAgyLocked(f.project, member.session_ref!, "native_tool", ancestors("agy")); return member; }
test("native agy identity uses conversation not trajectory, and resolves inherited identities by the nearest host", () => {
  const agy = randomUUID(), claude = randomUUID(), codex = randomUUID();
  const env = testEnv({ ANTIGRAVITY_CONVERSATION_ID: agy, ANTIGRAVITY_TRAJECTORY_ID: randomUUID(), AGENTCHAT_CLAUDE_SESSION_ID: claude, CODEX_THREAD_ID: codex });
  expect(identify(env, ancestors("agy"))).toEqual({ runtime: "agy", session: agy });
  expect(identify(env, [...ancestors("claude"), ...ancestors("agy")])).toEqual({ runtime: "claude", session: claude });
  expect(identify(env, [...ancestors("codex"), ...ancestors("agy")])).toEqual({ runtime: "codex", session: codex });
  for (const boundary of ["node", "bun", "python", "python3.14", "unknown-agent"]) expect(() => identify(env, [{ ...ancestors("agy")[0]!, executable: boundary }, ...ancestors("agy")])).toThrow("nearest native");
  expect(() => identify({ ANTIGRAVITY_CONVERSATION_ID: agy }, ancestors("codex"))).toThrow("nearest native host has no identity");
  expect(() => identify({ ANTIGRAVITY_TRAJECTORY_ID: agy }, ancestors("agy"))).toThrow("valid native session UUID");
  expect(() => identify({ ANTIGRAVITY_AGENTAPI_EXE: "/bin/agy", CODEX_THREAD_ID: codex }, ancestors("agy"))).toThrow("valid native session UUID");
});
test("join and sender notification use turn-based mode without saving credentials or reserving messages", async () => {
  const member = joined(), sender = store.join({ runtime: "generic", session: null }, "sender");
  const sent = store.send({ from: sender.id, to: member.id, notify: true, body: "not in notification" }).message;
  expect(agyMode(f.project, member.session_ref!)).toBe(AGY_TURN);
  expect(await notifyMember(store, f.project, member)).toMatchObject({ state: "held", reason: "next_native_invocation", reservation_consumed: false });
  expect(store.message(sent.id).notify_batch_id).toBeNull();
  expect(existsSync(join(f.project.room, "agy-wake"))).toBe(false);
  expect(receiver(f.project, member)).toMatchObject({ delivery: "turn_based", idle_wake: "deferred", compact: "untested" });
});
test("PreInvocation injects a compact notice once; ordinary reads still never mark", async () => {
  const member = joined(), from = store.join({ runtime: "generic", session: null }, "sender");
  store.send({ from: from.id, to: member.id, notify: true, id: "fresh-agy", body: "body is fetched separately" });
  const input = { conversationId: member.session_ref!, workspacePaths: [f.root] };
  expect(await agyHook(input, "SessionStart", ancestors("agy"))).toEqual({});
  expect(store.message("fresh-agy").notify_batch_id).toBeNull();
  const injected = await agyHook(input, "PreInvocation", ancestors("agy"));
  expect(JSON.stringify(injected)).toContain("fresh-agy"); expect(JSON.stringify(injected)).not.toContain("body is fetched separately");
  expect(injected).toHaveProperty("injectSteps"); expect(store.message("fresh-agy").notify_batch_id).not.toBeNull();
  expect(receiver(f.project, member).last_injection_unconfirmed).toMatchObject({ adapter: AGY_TURN, messageIds: ["fresh-agy"] });
  expect(store.actor({ runtime: "agy", session: member.session_ref }).read_seq).toBe(0);
  expect(await agyHook(input, "PreInvocation", ancestors("agy"))).toEqual({});
  expect(receiver(f.project, member).verification).toBe("unverified");
});
test("agy state cannot overwrite a different runtime with the same UUID", async () => {
  const agy = joined(), claude = store.join({ runtime: "claude", session: agy.session_ref });
  saveState(f.project, { session: claude.session_ref!, memberId: claude.id, active: true });
  const from = store.join({ runtime: "generic", session: null }, "sender");
  store.send({ from: from.id, to: agy.id, notify: true, id: "runtime-isolation", body: "isolated" });
  await agyHook({ conversationId: agy.session_ref!, workspacePaths: [f.root] }, "PreInvocation", ancestors("agy"));
  expect(state(f.project, claude)).toEqual({ session: claude.session_ref!, memberId: claude.id, active: true });
  expect(state(f.project, agy)?.injection?.messageIds).toEqual(["runtime-isolation"]);
});
test("exhausting the per-hook budget returns no injection and consumes no reservation", async () => {
  const member = joined(), from = store.join({ runtime: "generic", session: null }, "sender");
  store.send({ from: from.id, to: member.id, notify: true, id: "budget-held", body: "not yet reserved" });
  let tick = 0;
  expect(await agyHook({ conversationId: member.session_ref!, workspacePaths: [f.root] }, "PreInvocation", ancestors("agy"), { clock: () => tick += 1000, budgetMs: 2500 })).toEqual({});
  expect(store.message("budget-held").notify_batch_id).toBeNull();
  expect(state(f.project, member)?.injection).toBeUndefined();
});
test("hooks cannot create identities, join departed sessions or select an ambiguous workspace", async () => {
  const member = joined(), session = member.session_ref!;
  leaveSelectedRoom(f.project, { runtime: "agy", session });
  expect(await agyHook({ conversationId: session, workspacePaths: [f.root] }, "PreInvocation", ancestors("agy"))).toEqual({});
  writeJson(join(f.project.room, "config.json"), { budget: 20, windowSeconds: 600, autoJoin: true });
  const child = randomUUID();
  expect(await agyHook({ conversationId: child, workspacePaths: [f.root] }, "PreInvocation", ancestors("agy"))).toEqual({});
  expect(store.members()).toHaveLength(1);
  const other = fixture();
  try { await expect(agyHook({ conversationId: session, workspacePaths: [f.root, other.root] }, "PreInvocation", ancestors("agy"))).rejects.toThrow("ambiguous"); }
  finally { other.cleanup(); }
  await expect(agyHook({ conversationId: session, workspacePaths: ["relative"] }, "PreInvocation", ancestors("agy"))).rejects.toThrow("absolute");
});
test("room switching and uncertain pauses remain effective for turn-based injection", async () => {
  const member = joined(), sender = store.join({ runtime: "generic", session: null }, "sender");
  store.send({ from: sender.id, to: member.id, notify: true, id: "held", body: "hold" });
  pause(f.project, member, "uncertain_old_mode");
  const input = { conversationId: member.session_ref!, workspacePaths: [f.root] };
  expect(await agyHook(input, "PreInvocation", ancestors("agy"))).toEqual({});
  expect(store.message("held").notify_batch_id).toBeNull(); resume(f.project, member);
  createRoom(f.project, "another"); selectRoom(roomProject(f.project, "another"), { runtime: "agy", session: member.session_ref });
  expect(await notifyMember(store, f.project, member)).toMatchObject({ reason: "room_not_selected" });
  expect(await agyHook(input, "PreInvocation", ancestors("agy"))).toEqual({});
  expect(store.message("held").notify_batch_id).toBeNull();
});
