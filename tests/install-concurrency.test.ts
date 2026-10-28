import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { applyInstall, planInstall } from "../src/install.ts";
import { fixture, nativeIdentity, testEnv } from "./helpers.ts";
import { tryLock } from "../src/lock.ts";
import { privateDirectory } from "../src/files.ts";
import { cli } from "./helpers.ts";

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); }); afterEach(() => f.cleanup());
test("preview writes nothing and exposes exact owned hooks", async () => {
  const plan = await planInstall(f.project);
  expect(existsSync(f.project.room)).toBe(false); expect(existsSync(join(f.root, ".claude"))).toBe(false);
  expect((plan.hooks.Stop as { asyncRewake: boolean }[])[0]?.asyncRewake).toBe(true);
});
test("install is idempotent, preserves user hooks and never sets approval or inbound policy", async () => {
  mkdirSync(join(f.root, ".claude"));
  writeFileSync(join(f.root, ".claude/settings.local.json"), JSON.stringify({ permissions: { deny: ["Bash(curl:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] } }));
  writeFileSync(join(f.root, "AGENTS.md"), "User instructions\n");
  applyInstall(await planInstall(f.project));
  const settings = JSON.parse(readFileSync(join(f.root, ".claude/settings.local.json"), "utf8"));
  expect(settings.permissions.deny).toEqual(["Bash(curl:*)"]); expect(settings.crossSessionInbound).toBeUndefined(); expect(settings.hooks.Stop).toHaveLength(2);
  expect((await planInstall(f.project)).changes).toHaveLength(0);
  expect(readFileSync(join(f.root, "AGENTS.md"), "utf8").startsWith("User instructions\n")).toBe(true);
});
test("uninstall removes only owned blocks and hooks, preserving messages and subsequent user edits", async () => {
  writeFileSync(join(f.root, "AGENTS.md"), "Before\n"); applyInstall(await planInstall(f.project));
  const store = new Store(f.project.room, { create: true }); const member = store.join(nativeIdentity()); store.send({ from: member.id, body: "keep history" }); store.close();
  const path = join(f.root, "AGENTS.md"); writeFileSync(path, readFileSync(path, "utf8") + "After\n");
  applyInstall(await planInstall(f.project, { uninstall: true }));
  expect(readFileSync(path, "utf8")).toBe("Before\nAfter\n");
  expect(JSON.parse(readFileSync(join(f.root, ".claude/settings.local.json"), "utf8")).hooks).toBeUndefined();
  const reopened = new Store(f.project.room, { readonly: true }); expect(reopened.read(0).messages).toHaveLength(1); reopened.close();
});
test("installation detects concurrent changes before overwriting user files", async () => {
  writeFileSync(join(f.root, "AGENTS.md"), "before\n"); const plan = await planInstall(f.project);
  writeFileSync(join(f.root, "AGENTS.md"), "changed by user\n");
  expect(() => applyInstall(plan)).toThrow("File changed since preview"); expect(readFileSync(join(f.root, "AGENTS.md"), "utf8")).toBe("changed by user\n");
});
test("malformed existing hooks are refused without writes", async () => {
  mkdirSync(join(f.root, ".claude")); writeFileSync(join(f.root, ".claude/settings.local.json"), '{"hooks": []}');
  await expect(planInstall(f.project)).rejects.toThrow("hooks must be an object"); expect(existsSync(f.project.room)).toBe(false);
});
test("dangling configuration symlinks are refused rather than replaced", async () => {
  mkdirSync(join(f.root, ".claude")); symlinkSync(join(f.root, "missing"), join(f.root, ".claude/settings.local.json"));
  await expect(planInstall(f.project)).rejects.toThrow("non-regular"); expect(existsSync(f.project.room)).toBe(false);
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
test("Channels config is generated from the current native identity and never spoofs it via env", () => {
  const identity = nativeIdentity("claude"), env = testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: identity.session });
  expect(cli(f.root, ["install", "--apply"], env).status).toBe(0);
  expect(cli(f.root, ["join"], env).status).toBe(0);
  const plan = cli(f.root, ["channel-config"], env); expect(plan.status).toBe(0); expect(existsSync(plan.data.path)).toBe(false);
  expect(plan.data.config.mcpServers.agentchat.env).toBeUndefined(); expect(plan.data.launch_argv).toContain(identity.session);
  const applied = cli(f.root, ["channel-config", "--apply"], env); expect(applied.status).toBe(0); expect(existsSync(applied.data.path)).toBe(true);
  expect(applied.data.reception_verified).toBe(false);
});
test("partial installation failure rolls back only the files it wrote", async () => {
  writeFileSync(join(f.root, "AGENTS.md"), "original\n"); const plan = await planInstall(f.project);
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
  expect(await Promise.all(children.map(c => c.exited))).toEqual([0, 0, 0, 0]);
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
