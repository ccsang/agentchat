import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fixture, nativeIdentity } from "./helpers.ts";
import { Store } from "../src/store.ts";
import { applyMigration, inventoryPins, planMigration, previewMigration } from "../src/migrate.ts";
import { applyInstall, planInstall } from "../src/install.ts";
import { writeJson } from "../src/files.ts";
import { leaveSelectedRoom, selectRoom, roomProject, createRoom } from "../src/rooms.ts";
import { pause, paused } from "../src/runtime.ts";
import { tryLock } from "../src/lock.ts";
import * as crypto from "node:crypto";

let f: ReturnType<typeof fixture>, store: Store;
let config: string | undefined;
beforeEach(() => { f = fixture(); config = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = join(f.root, "claude-config"); store = new Store(f.project.room, { create: true }); });
afterEach(() => { store.close(); if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = config; f.cleanup(); });

test("new rooms remain v1 and agy join never implicitly migrates", () => {
  expect(store.schemaVersion()).toBe(1);
  expect(() => store.join({ runtime: "agy", session: crypto.randomUUID() })).toThrow("explicitly apply");
  expect(store.members()).toEqual([]); expect(store.schemaVersion()).toBe(1);
  expect(previewMigration(planMigration(f.project))).toMatchObject({ applied: false, from_schema: 1, to_schema: 2 });
  expect(existsSync(join(f.project.room, "migration.lock"))).toBe(false);
});
test("explicit migration preserves the two tables, data, cursor, foreign keys, triggers, reservations and pauses", () => {
  const a = store.join(nativeIdentity()), b = store.join(nativeIdentity("claude"));
  const message = store.send({ from: a.id, to: b.id, id: "pending", notify: true, body: "preserve" }).message;
  store.claim(b.id); store.mark(a.id, message.seq); pause(f.project, b, "existing_uncertainty");
  store.db.exec("CREATE INDEX custom_member_name ON members(name,created_at); CREATE TRIGGER custom_member_guard BEFORE DELETE ON members BEGIN SELECT RAISE(ABORT,'keep'); END;");
  const members = store.members(), messages = store.db.query("SELECT * FROM messages").all();
  const result = applyMigration(planMigration(f.project));
  expect(result).toMatchObject({ applied: true, changed: true });
  expect(store.schemaVersion()).toBe(2); expect(store.members()).toEqual(members);
  expect(store.db.query("SELECT * FROM messages").all()).toEqual(messages);
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(store.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "members" }, { name: "messages" }]);
  expect(() => store.db.query("DELETE FROM members WHERE id=?").run(a.id)).toThrow("keep");
  expect(() => store.db.query("UPDATE messages SET body='changed'").run()).toThrow("append-only");
  expect(() => store.db.query("DELETE FROM messages").run()).toThrow("append-only");
  expect(store.db.query("SELECT name FROM sqlite_master WHERE name='custom_member_name'").get()).not.toBeNull();
  expect(paused(f.project, b)?.reason).toBe("existing_uncertainty");
});
test("migration creates a consistent independently readable v1 backup and is idempotent", () => {
  const member = store.join(nativeIdentity()), sent = store.send({ from: member.id, body: "old history" }).message;
  const result = applyMigration(planMigration(f.project));
  const backup = new Database(result.backup as string, { readonly: true });
  try { expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 1 }); expect(backup.query("SELECT * FROM messages").all()).toEqual([sent]); }
  finally { backup.close(); }
  expect(applyMigration(planMigration(f.project))).toMatchObject({ changed: false, backup: null });
  expect(store.join({ runtime: "agy", session: crypto.randomUUID() }).runtime).toBe("agy");
  expect(readFileSync(result.backup as string).subarray(0, 16).toString()).toBe("SQLite format 3\0");
});
test("failure after table replacement rolls back to a v1 room usable for new writes", () => {
  const member = store.join(nativeIdentity());
  store.db.exec("CREATE INDEX member_name_lower ON members(lower(name))");
  const exec = Database.prototype.exec;
  const fail = spyOn(Database.prototype, "exec").mockImplementation(function(this: Database, sql: string) {
    if (sql === "PRAGMA user_version=2") throw new Error("injected migration failure");
    return exec.call(this, sql);
  });
  try { expect(() => applyMigration(planMigration(f.project))).toThrow("injected migration failure"); }
  finally { fail.mockRestore(); }
  expect(store.schemaVersion()).toBe(1); expect(store.members()).toEqual([member]);
  expect(store.send({ from: member.id, body: "usable after rollback" }).message.seq).toBe(1);
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("known old participating entries block apply unless explicitly overridden; hook command strings are never executed", async () => {
  applyInstall(await planInstall(f.project));
  const entry = join(f.project.room, "agentchat.js");
  writeFileSync(entry, readFileSync(entry, "utf8").replace('var version = "0.1.0-alpha.14";', 'var version = "0.1.0-alpha.13";'));
  const pins = inventoryPins(f.project);
  expect(pins.some(p => p.version === "0.1.0-alpha.13" && p.status === "old")).toBe(true);
  expect(() => applyMigration(planMigration(f.project))).toThrow("Upgrade known");
  expect(store.schemaVersion()).toBe(1);
  const sentinel = join(f.root, "must-not-execute");
  writeJson(join(f.root, ".claude", "settings.local.json"), { hooks: { SessionStart: [{ hooks: [{ command: `touch ${sentinel}`, args: ["--agentchat-managed=v1"] }] }] } });
  const plan = planMigration(f.project);
  expect(plan.pins.some(p => p.kind === "managed_hook" && p.status === "unknown")).toBe(true);
  expect(existsSync(sentinel)).toBe(false);
  expect(applyMigration(plan, true)).toMatchObject({ changed: true, old_pins_overridden: true });
  expect(existsSync(sentinel)).toBe(false);
});
test("migration is single-room and preserves existing Claude/Codex send/read/mark/selection/leave semantics", () => {
  createRoom(f.project, "other"); const other = new Store(roomProject(f.project, "other").room);
  try {
    applyMigration(planMigration(f.project)); expect(other.schemaVersion()).toBe(1);
    const a = store.join(nativeIdentity()), b = store.join(nativeIdentity("claude"));
    const selected = { runtime: a.runtime, session: a.session_ref };
    selectRoom(f.project, selected); const sent = store.send({ from: a.id, to: b.id, notify: true, body: "new history" });
    expect(store.read(0).messages).toEqual([sent.message]); expect(store.mark(a.id, sent.message.seq)).toBe(sent.message.seq);
    expect(store.claim(b.id).batch?.messages[0]?.id).toBe(sent.message.id);
    leaveSelectedRoom(f.project, selected); expect(store.actor(selected).read_seq).toBe(sent.message.seq);
    expect(store.join(selected).id).toBe(a.id);
  } finally { other.close(); }
});
test("migration refuses a stale plan or another migration lock without changing data", async () => {
  const plan = planMigration(f.project), release = tryLock(join(f.project.room, "migration.lock"))!;
  try { expect(() => applyMigration(plan)).toThrow("Another migration"); } finally { release(); }
  applyInstall(await planInstall(f.project)); expect(() => applyMigration(plan)).toThrow("changed since preview");
  expect(store.schemaVersion()).toBe(1);
});
test("inventory includes enabled user plugin hook's global CLI without evaluating plugin commands", async () => {
  applyInstall(await planInstall(f.project));
  const config = process.env.CLAUDE_CONFIG_DIR!, plugin = join(f.root, "plugin");
  writeJson(join(config, "settings.json"), { enabledPlugins: { "agentchat@test": true } });
  writeJson(join(config, "plugins", "installed_plugins.json"), { version: 2, plugins: { "agentchat@test": [{ scope: "user", installPath: plugin }] } });
  writeJson(join(plugin, "scripts", "placeholder.json"), {});
  writeFileSync(join(plugin, "scripts", "hook.sh"), '#!/bin/sh\nexec "$cli" hook "plugin-$1"\n', { mode: 0o700 });
  const entry = join(f.project.room, "agentchat.js");
  writeFileSync(entry, readFileSync(entry, "utf8").replace('var version = "0.1.0-alpha.14";', 'var version = "0.1.0-alpha.13";'));
  const bin = join(f.root, "bin"); writeJson(join(bin, "placeholder.json"), {});
  writeFileSync(join(bin, "agentchat"), `#!/bin/sh\n# agentchat:program-v1\nexec '${process.execPath}' '${entry}' "$@"\n`, { mode: 0o700 });
  const before = process.env.AGENTCHAT_BIN_DIR; process.env.AGENTCHAT_BIN_DIR = bin;
  try { expect(inventoryPins(f.project).filter(p => p.source.endsWith("hook.sh"))).toMatchObject([{ kind: "managed_hook", status: "old", version: "0.1.0-alpha.13" }]); }
  finally { if (before === undefined) delete process.env.AGENTCHAT_BIN_DIR; else process.env.AGENTCHAT_BIN_DIR = before; }
});
test("native agy plugin hooks also inventory their global CLI instead of assuming the project pin", async () => {
  applyInstall(await planInstall(f.project));
  const plugin = join(f.root, ".agents", "plugins", "agentchat-agy");
  writeJson(join(plugin, "plugin.json"), { name: "agentchat-agy" });
  writeJson(join(plugin, "hooks.json"), { agentchat: { enabled: true, PreInvocation: [{ command: "sh ./scripts/hook.sh pre-invocation" }] } });
  writeJson(join(plugin, "scripts", "placeholder.json"), {});
  writeFileSync(join(plugin, "scripts", "hook.sh"), '#!/bin/sh\nexec "$cli" hook "agy-$1"\n', { mode: 0o700 });
  const entry = join(f.root, "old.js"), bin = join(f.root, "bin");
  writeFileSync(entry, readFileSync(join(f.project.room, "agentchat.js"), "utf8").replace('var version = "0.1.0-alpha.14";', 'var version = "0.1.0-alpha.13";'), { mode: 0o600 });
  writeJson(join(bin, "placeholder.json"), {});
  writeFileSync(join(bin, "agentchat"), `#!/bin/sh\n# agentchat:program-v1\nexec '${process.execPath}' '${entry}' "$@"\n`, { mode: 0o700 });
  const before = process.env.AGENTCHAT_BIN_DIR; process.env.AGENTCHAT_BIN_DIR = bin;
  try {
    expect(planMigration(f.project).pins.find(p => p.source === join(plugin, "hooks.json"))).toMatchObject({ version: "0.1.0-alpha.13", status: "old" });
    expect(() => applyMigration(planMigration(f.project))).toThrow("Upgrade known");
    writeJson(join(plugin, "hooks.json"), { agentchat: { enabled: false } });
    expect(planMigration(f.project).pins.some(p => p.source === join(plugin, "hooks.json"))).toBe(false);
  } finally { if (before === undefined) delete process.env.AGENTCHAT_BIN_DIR; else process.env.AGENTCHAT_BIN_DIR = before; }
});
