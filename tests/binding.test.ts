import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createLaunch as pendingLaunch, readLaunch, waitForLaunchHost } from "../src/binding.ts";
import { fixtureLaunch as createLaunch } from "./helpers.ts";
import { registerHook } from "../src/hooks.ts";
import { Store } from "../src/store.ts";
import { applyInstall, planInstall } from "../src/install.ts";
import { cli, fixture, testEnv } from "./helpers.ts";

function hook(root: string, session = randomUUID()) { return { session_id: session, cwd: root, hook_event_name: "SessionStart" }; }
test("each launch binds only its own SessionStart and enrolls after the trusted hook context arrives", () => {
  const f = fixture(), session = randomUUID(), launch = createLaunch(f.project, session, "Claude fixture");
  try {
    expect(readLaunch(f.project, launch.env).status).toBe("pending"); expect(existsSync(join(f.project.room, "chat.db"))).toBe(false);
    const context = registerHook(f.project, hook(f.root, session), launch.env).hookSpecificOutput as { additionalContext: string };
    expect(context.additionalContext).toContain(JSON.stringify([join(f.project.room, "run"), "--project", f.root]));
    expect(context.additionalContext).toContain("No project instruction file is required");
    const binding = readLaunch(f.project, launch.env); expect(binding.session).toBe(session); expect(binding.status).toBe("bound");
    const store = new Store(f.project.room); expect(store.members()).toHaveLength(1); expect(store.actor({ runtime: "claude", session }).session_ref).toBe(session); store.close();
    expect(statSync(join(f.project.room, "launches", `${launch.binding.id}.json`)).mode & 0o777).toBe(0o600);
  } finally { launch.close(); f.cleanup(); }
});
test("wrong resume identity invalidates the launch before enrolling or claiming messages", () => {
  const f = fixture(), launch = createLaunch(f.project, randomUUID(), "fixture");
  try {
    expect(() => registerHook(f.project, hook(f.root), launch.env)).toThrow("differs");
    expect(() => readLaunch(f.project, launch.env)).toThrow("Native session changed");
    expect(existsSync(join(f.project.room, "chat.db"))).toBe(false);
  } finally { launch.close(); f.cleanup(); }
});
test("a resumed or cleared session cannot repurpose the first session's live Channel", () => {
  const f = fixture(), launch = createLaunch(f.project, null, "fixture");
  try {
    registerHook(f.project, hook(f.root), launch.env);
    expect(() => registerHook(f.project, hook(f.root), launch.env)).toThrow("differs");
    const store = new Store(f.project.room); expect(store.members()).toHaveLength(1); store.close();
  } finally { launch.close(); f.cleanup(); }
});
test("two concurrent launches bind independently; copied project or token context is rejected", () => {
  const f = fixture(), other = fixture(), first = createLaunch(f.project, null, "fixture"), second = createLaunch(f.project, null, "fixture");
  try {
    const a = hook(f.root), b = hook(f.root); registerHook(f.project, a, first.env); registerHook(f.project, b, second.env);
    expect(readLaunch(f.project, first.env).session).toBe(a.session_id); expect(readLaunch(f.project, second.env).session).toBe(b.session_id);
    expect(() => readLaunch(f.project, { ...first.env, AGENTCHAT_LAUNCH_TOKEN: second.binding.token })).toThrow("another launch");
    expect(() => registerHook(other.project, hook(other.root), first.env)).toThrow();
  } finally { first.close(); second.close(); f.cleanup(); other.cleanup(); }
});
test("finished launch contexts cannot be replayed, even with their stored token", () => {
  const f = fixture(), launch = createLaunch(f.project, null, "fixture");
  try { registerHook(f.project, hook(f.root), launch.env); launch.close(); expect(() => readLaunch(f.project, launch.env)).toThrow("no longer running"); }
  finally { f.cleanup(); }
});
test("copying a still-live MCP config into another host process cannot enroll or read as its original session", () => {
  const f = fixture(), session = randomUUID(), launch = createLaunch(f.project, session, "fixture");
  try {
    registerHook(f.project, hook(f.root, session), launch.env);
    const copied = cli(f.root, ["notify", "claude-channel"], testEnv(launch.env));
    expect(copied.status).toBe(2); expect(copied.data.error.code).toBe("E_BINDING"); expect(copied.data.error.message).toContain("direct child");
    const hookCopy = cli(f.root, ["--agentchat-managed=v1", "hook", "session-start"], testEnv(launch.env), JSON.stringify(hook(f.root, session)));
    expect(hookCopy.status).toBe(1); expect(hookCopy.data.error.code).toBe("E_BINDING");
    expect(readLaunch(f.project, launch.env).session).toBe(session);
  } finally { launch.close(); f.cleanup(); }
});
test("SessionStart can wait for the launcher to register its native child after spawn", async () => {
  const f = fixture(), launch = pendingLaunch(f.project, null, "fixture");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const waiting = waitForLaunchHost(f.project, launch.env);
    timer = setTimeout(() => launch.attachHost(process.ppid), 20);
    await waiting; registerHook(f.project, hook(f.root), launch.env);
    expect(readLaunch(f.project, launch.env).status).toBe("bound");
  } finally { if (timer) clearTimeout(timer); launch.close(); f.cleanup(); }
});
test("upgrade removes only managed Stop listeners and migrates a lifetime budget to a rolling window", async () => {
  const f = fixture();
  try {
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
  } finally { f.cleanup(); }
});
test("a peer can prepare an exact Claude resume entry, without impersonating or launching the native session", async () => {
  const f = fixture();
  try {
    applyInstall(await planInstall(f.project, { hooks: true })); const store = new Store(f.project.room, { create: true });
    const member = store.join({ runtime: "claude", session: randomUUID() }); store.close();
    const result = cli(f.root, ["channel-config", "--to", member.id, "--apply"], testEnv({ CODEX_THREAD_ID: randomUUID() }));
    expect(result.status).toBe(0); expect(result.data.script).toContain(member.id); expect(result.data.script).not.toContain("AGENTCHAT_CLAUDE_SESSION_ID");
    expect(result.data.reception_verified).toBe(false); expect(existsSync(join(f.project.room, "launches"))).toBe(false);
    expect(cli(f.root, ["launch", "claude", "--to", member.id]).data.error.code).toBe("E_HOST_ACTION");
  } finally { f.cleanup(); }
});
test("installed entry does not depend on Bun being on the caller's PATH", async () => {
  const f = fixture();
  try {
    applyInstall(await planInstall(f.project));
    const result = spawnSync(join(f.project.room, "run"), ["--version"], { cwd: f.root, env: testEnv({ PATH: "/usr/bin:/bin" }), encoding: "utf8" });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toContain("0.1.");
  } finally { f.cleanup(); }
});
