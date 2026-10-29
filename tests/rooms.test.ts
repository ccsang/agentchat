import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { cli, fixture, git, testEnv } from "./helpers.ts";
import { createRoom, roomProject, selectRoom } from "../src/rooms.ts";
import { Store } from "../src/store.ts";
import { dispatchCodex } from "../src/notify.ts";
import { listenerLock, pause, paused, resume, saveState } from "../src/runtime.ts";
import { privateDirectory } from "../src/files.ts";
import { tryLock } from "../src/lock.ts";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); }); afterEach(() => f.cleanup());
const identity = () => testEnv({ CODEX_THREAD_ID: randomUUID() });
test("first join initializes a project once and later sessions preserve configuration and history", () => {
  writeFileSync(join(f.root, "AGENTS.md"), "User instructions\n");
  writeFileSync(join(f.root, "CLAUDE.md"), "Existing Claude instructions\n");
  mkdirSync(join(f.root, ".claude")); writeFileSync(join(f.root, ".claude/settings.local.json"), "Not JSON; join must not read or repair this file\n");
  const a = identity(), b = identity();
  const first = cli(f.root, ["join"], a);
  expect(first.status).toBe(0); expect(first.data.initialization.initialized).toBe(true);
  const files = ["AGENTS.md", "CLAUDE.md", ".claude/settings.local.json"].map(path => readFileSync(join(f.root, path), "utf8"));
  cli(f.root, ["send", "--text", "keep history"], a);
  const next = cli(f.root, ["join"], b), repeated = cli(f.root, ["join"], a);
  expect(next.data.initialization.initialized).toBe(false); expect(repeated.data.member.id).toBe(first.data.member.id);
  expect(["AGENTS.md", "CLAUDE.md", ".claude/settings.local.json"].map(path => readFileSync(join(f.root, path), "utf8"))).toEqual(files);
  expect(cli(f.root, ["read"], b).data.messages[0].body).toBe("keep history");
});
test("listing rooms is read-only and creating a room does not initialize project hooks", () => {
  expect(cli(f.root, ["room", "list"]).data.rooms).toEqual([]);
  expect(cli(f.root, ["room", "current"]).data.current).toBeNull();
  expect(existsSync(f.project.room)).toBe(false);
  expect(cli(f.root, ["room", "create", "review"]).data.created).toBe(true);
  expect(existsSync(join(f.root, ".claude"))).toBe(false); expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
  expect(cli(f.root, ["room", "create", "review"]).data.created).toBe(false);
  expect(cli(f.root, ["room", "list"]).data.rooms.map((room: { name: string }) => room.name)).toEqual(["review"]);
});
test("room selection belongs to one native session and explicit read/send never change that selection", () => {
  const a = identity(), b = identity(); cli(f.root, ["join"], a); cli(f.root, ["join"], b);
  cli(f.root, ["send", "--id", "same-id", "--text", "default body"], a);
  cli(f.root, ["read", "--mark", "1"], a);
  cli(f.root, ["room", "create", "review"]);
  expect(cli(f.root, ["room", "use", "review"], a).data.initialization.initialized).toBe(false);
  cli(f.root, ["send", "--id", "same-id", "--text", "review body"], a);
  expect(cli(f.root, ["room", "current"], a).data.current).toBe("review");
  expect(cli(f.root, ["room", "current"], b).data.current).toBe("default");
  expect(cli(f.root, ["read", "--id", "same-id"], a).data.message.body).toBe("review body");
  expect(cli(f.root, ["--room", "default", "read", "--id", "same-id"], a).data.message.body).toBe("default body");
  cli(f.root, ["--room", "default", "send", "--reply-to", "same-id", "--text", "reply to default"], a);
  expect(cli(f.root, ["room", "current"], a).data.current).toBe("review");
  expect(cli(f.root, ["room", "use", "default"], a).data.member.read_seq).toBe(1);
  expect(cli(f.root, ["read", "--new"], a).data.messages[0].body).toBe("reply to default");
});
test("a new project can join a pre-created named room without creating an unused default database", () => {
  cli(f.root, ["room", "create", "review"]);
  const result = cli(f.root, ["join", "--room", "review"], identity());
  expect(result.status).toBe(0); expect(result.data.initialization.initialized).toBe(true);
  expect(existsSync(join(f.project.room, "chat.db"))).toBe(false);
  expect(existsSync(join(f.root, ".claude/settings.local.json"))).toBe(false);
});
test("unknown rooms, traversal names and foreign absolute paths fail before project initialization", () => {
  const env = identity();
  for (const room of ["missing", "../escape", "/tmp/foreign-room"]) expect(cli(f.root, ["join", "--room", room], env).status).not.toBe(0);
  expect(cli(f.root, ["room", "create", "../escape"]).status).not.toBe(0);
  expect(existsSync(f.project.room)).toBe(false); expect(existsSync(join(f.root, ".claude"))).toBe(false);
});
test("room lookup refuses directory symlinks rather than reading another room's database", () => {
  createRoom(f.project, "real");
  symlinkSync(roomProject(f.project, "real").room, join(f.project.room, "rooms", "alias"));
  expect(cli(f.root, ["join", "--room", "alias"], identity()).data.error.code).toBe("E_PERMISSIONS");
});
test("worktrees share named rooms but prepare their own local runtime once", () => {
  git(f.root, ["init", "-b", "main"]);
  git(f.root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const linked = join(f.root, "linked"); git(f.root, ["worktree", "add", "-b", "linked", linked]);
  const a = identity(), b = identity();
  cli(f.root, ["join"], a); cli(f.root, ["room", "create", "review"]);
  const result = cli(linked, ["join", "--room", "review"], b);
  expect(result.status).toBe(0); expect(result.data.initialization.initialized).toBe(true);
  expect(existsSync(join(linked, ".claude/settings.local.json"))).toBe(false);
  expect(cli(linked, ["join"], b).data.initialization.initialized).toBe(false);
  expect(cli(f.root, ["room", "list"], a).data.rooms).toHaveLength(2);
});
test("a session that moved rooms is not notified in its old room and consumes no reservation", () => {
  const store = new Store(f.project.room, { create: true });
  try {
    const a = store.join({ runtime: "generic", session: null }, "sender"), b = store.join({ runtime: "codex", session: randomUUID() });
    createRoom(f.project, "review"); selectRoom(roomProject(f.project, "review"), { runtime: b.runtime, session: b.session_ref });
    store.send({ from: a.id, to: b.id, id: "pending", body: "keep this", notify: true });
    expect(dispatchCodex(store, f.project, b)).toMatchObject({ state: "held", reason: "room_not_selected" });
    expect(store.message("pending").notify_batch_id).toBeNull();
  } finally { store.close(); }
});
test("unknown notification pauses follow the native session across rooms and resume preserves old reservations", () => {
  const store = new Store(f.project.room, { create: true }); createRoom(f.project, "review");
  const target = roomProject(f.project, "review"), other = new Store(target.room);
  try {
    const id = { runtime: "codex" as const, session: randomUUID() }, member = store.join(id), next = other.join(id);
    pause(f.project, member, "native_outcome_unknown"); selectRoom(target, id);
    expect(paused(target, next)?.reason).toBe("native_outcome_unknown");
    expect(dispatchCodex(other, target, next).state).toBe("paused");
    resume(target, next); expect(paused(f.project, member)).toBeNull(); expect(paused(target, next)).toBeNull();
  } finally { other.close(); store.close(); }
});
test("malformed session selection is rejected without falling back to another room", () => {
  const env = identity(); cli(f.root, ["join"], env);
  writeFileSync(join(f.project.room, "room-selections", `codex-${env.CODEX_THREAD_ID}.json`), JSON.stringify({ runtime: "codex", session: randomUUID(), name: "default" }), { mode: 0o600 });
  expect(cli(f.root, ["read"], env).data.error.code).toBe("E_IDENTITY");
});
test("two first joins can initialize one project concurrently without losing either membership", async () => {
  const path = join(import.meta.dir, "../bin/agentchat");
  const children = [identity(), identity()].map(env => Bun.spawn([process.execPath, path, "--project", f.root, "join"], { env, stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => ({ status: await child.exited, out: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
  expect(results.map(result => ({ status: result.status, error: result.error }))).toEqual([{ status: 0, error: "" }, { status: 0, error: "" }]);
  expect(cli(f.root, ["members"]).data.members).toHaveLength(2);
});
test("an older live Channel must be restored through the updated launcher before switching rooms", () => {
  const store = new Store(f.project.room, { create: true });
  const member = store.join({ runtime: "claude", session: randomUUID() });
  createRoom(f.project, "review"); privateDirectory(join(f.project.room, "listeners"));
  const release = tryLock(listenerLock(f.project, member))!;
  saveState(f.project, { session: member.session_ref!, active: true, listener: { mode: "channel", pid: process.pid, token: randomUUID(), launchId: randomUUID(), expiresAt: Date.now() + 30000 } });
  try {
    const env = testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: member.session_ref! });
    const result = cli(f.root, ["room", "use", "review"], env);
    expect(result.status).toBe(2); expect(result.data.error.code).toBe("E_RECEIVER");
    expect(cli(f.root, ["room", "current"], env).data.current).toBe("default");
    expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
  } finally { release(); store.close(); }
});
