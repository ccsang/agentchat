import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { applyInstall, planInstall } from "../src/install.ts";
import { fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tryLock } from "../src/lock.ts";
import { privateDirectory } from "../src/files.ts";
import { cli } from "./helpers.ts";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); }); afterEach(() => f.cleanup());
test("preview writes nothing and exposes exact owned hooks", async () => {
  const plan = await planInstall(f.project, { hooks: true });
  expect(existsSync(f.project.room)).toBe(false); expect(existsSync(join(f.root, ".claude"))).toBe(false);
  expect(plan.hooks.Stop).toBeUndefined(); expect(plan.hooks.SessionStart).toBeDefined();
});
test("explicit hook upgrade retires only managed Stop listeners and preserves budget and user hooks", async () => {
  mkdirSync(join(f.root, ".claude")); mkdirSync(f.project.room, { mode: 0o700 });
  writeFileSync(join(f.project.room, "config.json"), JSON.stringify({ budget: 7, watchSeconds: 300, autoJoin: false }), { mode: 0o600 });
  writeFileSync(join(f.root, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: "command", command: "old", args: ["--agentchat-managed=v1", "hook", "wait"], asyncRewake: true },
    { type: "command", command: "user-custom-hook" },
  ] }] } }));
  applyInstall(await planInstall(f.project, { hooks: true }));
  const settings = JSON.parse(readFileSync(join(f.root, ".claude/settings.local.json"), "utf8"));
  expect(settings.hooks.Stop[0].hooks).toEqual([{ type: "command", command: "user-custom-hook" }]);
  const config = JSON.parse(readFileSync(join(f.project.room, "config.json"), "utf8"));
  expect(config.budget).toBe(7); expect(config.windowSeconds).toBe(600); expect(config.watchSeconds).toBeUndefined();
});
test("explicit runtime and managed-hook upgrade replaces stale code and handles a missing compact environment", async () => {
  applyInstall(await planInstall(f.project, { hooks: true }));
  const path = join(f.root, ".claude/settings.local.json"), settings = JSON.parse(readFileSync(path, "utf8"));
  settings.hooks.SessionStart[0].hooks[0].command = "/missing-legacy-agentchat";
  settings.hooks.Stop = [{ hooks: [{ type: "command", command: "user-hook" }] }];
  settings.permissions = { deny: ["Bash(curl:*)"] };
  const before = JSON.stringify(settings); writeFileSync(path, before);
  writeFileSync(join(f.project.room, "agentchat.js"), "throw new Error('stale installed bundle');\n");
  const plan = await planInstall(f.project, { hooks: true });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(plan.changes.some(change => change.path === join(f.project.room, "agentchat.js"))).toBe(true);
  expect(plan.changes.some(change => change.path === path)).toBe(true);
  applyInstall(plan);
  const after = JSON.parse(readFileSync(path, "utf8")), hook = after.hooks.SessionStart[0].hooks[0];
  expect(after.hooks.Stop).toEqual(settings.hooks.Stop); expect(after.permissions).toEqual(settings.permissions);
  const envPath = join(f.root, "compact-env.sh"), session = randomUUID();
  const result = spawnSync(hook.command, hook.args, { encoding: "utf8", env: testEnv({ CLAUDE_ENV_FILE: envPath, CLAUDE_CONFIG_DIR: join(f.root, "isolated-claude") }),
    input: JSON.stringify({ cwd: f.root, session_id: session, hook_event_name: "SessionStart", source: "compact" }) });
  expect(result.status).toBe(0); expect(readFileSync(envPath, "utf8")).toBe(`export AGENTCHAT_CLAUDE_SESSION_ID='${session}'\n`);
  expect((await planInstall(f.project, { hooks: true })).changes).toHaveLength(0);
  expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
});
test("install is idempotent, preserves user hooks and never sets approval or inbound policy", async () => {
  mkdirSync(join(f.root, ".claude"));
  writeFileSync(join(f.root, ".claude/settings.local.json"), JSON.stringify({ permissions: { deny: ["Bash(curl:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] } }));
  writeFileSync(join(f.root, "AGENTS.md"), "User instructions\n");
  applyInstall(await planInstall(f.project, { instructions: true, hooks: true }));
  const settings = JSON.parse(readFileSync(join(f.root, ".claude/settings.local.json"), "utf8"));
  expect(settings.permissions.deny).toEqual(["Bash(curl:*)"]); expect(settings.crossSessionInbound).toBeUndefined(); expect(settings.hooks.Stop).toHaveLength(1);
  expect((await planInstall(f.project, { instructions: true, hooks: true })).changes).toHaveLength(0);
  expect(readFileSync(join(f.root, "AGENTS.md"), "utf8").startsWith("User instructions\n")).toBe(true);
});
test("uninstall removes only owned blocks and hooks, preserving messages and subsequent user edits", async () => {
  writeFileSync(join(f.root, "AGENTS.md"), "Before\n"); applyInstall(await planInstall(f.project, { instructions: true, hooks: true }));
  const store = new Store(f.project.room, { create: true }); const member = store.join(nativeIdentity()); store.send({ from: member.id, body: "keep history" }); store.close();
  const path = join(f.root, "AGENTS.md"); writeFileSync(path, readFileSync(path, "utf8") + "After\n");
  applyInstall(await planInstall(f.project, { uninstall: true }));
  expect(readFileSync(path, "utf8")).toBe("Before\nAfter\n");
  expect(JSON.parse(readFileSync(join(f.root, ".claude/settings.local.json"), "utf8")).hooks).toBeUndefined();
  const reopened = new Store(f.project.room, { readonly: true }); expect(reopened.read(0).messages).toHaveLength(1); reopened.close();
});
test("installation detects concurrent changes before overwriting user files", async () => {
  writeFileSync(join(f.root, "AGENTS.md"), "before\n"); const plan = await planInstall(f.project, { instructions: true });
  writeFileSync(join(f.root, "AGENTS.md"), "changed by user\n");
  expect(() => applyInstall(plan)).toThrow("File changed since preview"); expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe("changed by user\n");
});
test("malformed existing hooks are refused without writes", async () => {
  mkdirSync(join(f.root, ".claude")); writeFileSync(join(f.root, ".claude/settings.local.json"), '{"hooks": []}');
  await expect(planInstall(f.project, { hooks: true })).rejects.toThrow("hooks must be an object"); expect(existsSync(f.project.room)).toBe(false);
});
test("dangling configuration symlinks are refused rather than replaced", async () => {
  mkdirSync(join(f.root, ".claude")); symlinkSync(join(f.root, "missing"), join(f.root, ".claude/settings.local.json"));
  await expect(planInstall(f.project, { hooks: true })).rejects.toThrow("non-regular"); expect(existsSync(f.project.room)).toBe(false);
});
test("an installed standalone copy can preview itself without source checkout or repeated rewriting", async () => {
  applyInstall(await planInstall(f.project));
  const entry = join(f.project.room, "agentchat.js");
  const child = Bun.spawn([process.execPath, entry, "--project", f.root, "install"], { env: testEnv(), stdout: "pipe", stderr: "pipe" });
  const result = await new Response(child.stdout).json() as { changes: unknown[] };
  expect(await child.exited).toBe(0); expect(result.changes).toHaveLength(0);
});
test("explicit auto-join opt-out is preserved in installed policy", () => {
  expect(cli(f.root, ["install", "--apply", "--auto-join"]).status).toBe(0);
  expect(cli(f.root, ["install", "--apply", "--no-auto-join"]).status).toBe(0);
  expect(JSON.parse(readFileSync(join(f.project.room, "config.json"), "utf8")).autoJoin).toBe(false);
});
test("Channel configuration and launch commands retire without preparing a client", () => {
  const env = testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: nativeIdentity("claude").session });
  for (const args of [["channel-config", "--apply"], ["launch", "claude"], ["notify", "claude-channel"]]) {
    expect(cli(f.root, args, env).data.error.code).toBe("E_RETIRED");
  }
  expect(existsSync(f.project.room)).toBe(false);
});

test("partial installation failure rolls back only the files it wrote", async () => {
  writeFileSync(join(f.root, "AGENTS.md"), "original\n"); const plan = await planInstall(f.project, { instructions: true, hooks: true });
  const badParent = join(f.root, "not-a-directory"); writeFileSync(badParent, "user data");
  plan.changes.push({ path: join(badParent, "fail"), before: null, after: "x", mode: 0o600 });
  expect(() => applyInstall(plan)).toThrow();
  expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe("original\n");
  expect(readFileSync(badParent, "utf8")).toBe("user data");
  expect(existsSync(join(f.root, ".claude/settings.local.json"))).toBe(false);
});
test("kernel file locks exclude a second owner and release without deleting the lock file", () => {
  privateDirectory(f.project.room); const lock = join(f.project.room, "lock"); const release = tryLock(lock);
  expect(release).not.toBeNull(); expect(tryLock(lock)).toBeNull(); release!();
  const again = tryLock(lock); expect(again).not.toBeNull(); again!();
});
test("four processes append 200 unique messages without loss", async () => {
  const store = new Store(f.project.room, { create: true }); const member = store.join(nativeIdentity()); store.close();
  const children = Array.from({ length: 4 }, (_, i) => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker.ts"), "write", f.project.room, member.id, `writer${i}`, "50"], { env: testEnv(), stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async child => ({ exit: await child.exited, stderr: await new Response(child.stderr).text() })));
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ exit: 0, stderr: "" })));
  const reopened = new Store(f.project.room, { readonly: true });
  expect(reopened.db.query("SELECT count(*) n,count(DISTINCT id) ids FROM messages").get()).toEqual({ n: 200, ids: 200 }); reopened.close();
});
test("concurrent identical retries insert a single message", async () => {
  const store = new Store(f.project.room, { create: true }); const member = store.join(nativeIdentity()); store.close();
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker.ts"), "same", f.project.room, member.id], { env: testEnv(), stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(c => c.exited))).toEqual([0, 0, 0, 0]);
  const reopened = new Store(f.project.room, { readonly: true }); expect(reopened.read(0).messages).toHaveLength(1); reopened.close();
});
test("concurrent notification claimers reserve one batch only", async () => {
  const store = new Store(f.project.room, { create: true }); const a = store.join(nativeIdentity()), b = store.join(nativeIdentity("claude"));
  store.send({ from: a.id, to: b.id, notify: true, body: "once" }); store.close(); const now = Date.now();
  const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/worker.ts"), "claim", f.project.room, b.id, String(now)], { env: testEnv(), stdout: "pipe", stderr: "pipe" }));
  const results = await Promise.all(children.map(async c => { expect(await c.exited).toBe(0); return JSON.parse(await new Response(c.stdout).text()); }));
  expect(results.filter(r => r.batch)).toHaveLength(1);
});
