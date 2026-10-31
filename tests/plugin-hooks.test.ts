import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { applyInstall, planInstall } from "../src/install.ts";
import { pluginHook } from "../src/hooks.ts";
import { Store } from "../src/store.ts";
import { receiver, saveState, state } from "../src/runtime.ts";
import { fixture, git, testEnv } from "./helpers.ts";
import { createRoom, roomProject, selectRoom } from "../src/rooms.ts";
import { discoverProject } from "../src/project.ts";
import { workspaceDir } from "../src/workspace.ts";

let f: ReturnType<typeof fixture>, host: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); host = fixture(); }); afterEach(() => { f.cleanup(); host.cleanup(); });
function input(event = "SessionStart", session = randomUUID()) { return { hook_event_name: event, session_id: session, cwd: f.root }; }
const envFor = () => testEnv({ CLAUDE_CONFIG_DIR: join(host.root, "claude") });
test("plugin startup persists real hook identity without initializing an unjoined project", () => {
  const path = join(host.root, "env"); writeFileSync(path, "export USER_RULE='keep'", { mode: 0o600 });
  const context = input(), env = { ...envFor(), CLAUDE_ENV_FILE: path };
  expect(pluginHook(context, "SessionStart", env)).toEqual({}); pluginHook(context, "SessionStart", env);
  expect(readFileSync(path, "utf8")).toBe(`export USER_RULE='keep'\nexport AGENTCHAT_CLAUDE_SESSION_ID='${context.session_id}'\n`);
  expect(readdirSync(f.root)).toEqual([]);
});
test("startup, resume and compact create a missing host environment file without duplicating identity", () => {
  for (const source of ["startup", "resume", "compact"]) {
    const path = join(host.root, `${source}-env.sh`), context = { ...input(), source };
    const env = { ...envFor(), CLAUDE_ENV_FILE: path };
    expect(existsSync(path)).toBe(false);
    expect(pluginHook(context, "SessionStart", env)).toEqual({});
    const expected = `export AGENTCHAT_CLAUDE_SESSION_ID='${context.session_id}'\n`;
    expect(readFileSync(path, "utf8")).toBe(expected);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    pluginHook(context, "SessionStart", env);
    expect(readFileSync(path, "utf8")).toBe(expected);
  }
  expect(readdirSync(f.root)).toEqual([]);
});
test("host environment writes reject links and missing parent directories", () => {
  const target = join(host.root, "user-file"); writeFileSync(target, "preserve\n", { mode: 0o600 });
  for (const [name, destination] of [["live", target], ["dangling", join(host.root, "absent")]] as const) {
    const path = join(host.root, name); symlinkSync(destination, path);
    expect(() => pluginHook(input(), "SessionStart", { ...envFor(), CLAUDE_ENV_FILE: path })).toThrow();
  }
  expect(readFileSync(target, "utf8")).toBe("preserve\n");
  expect(existsSync(join(host.root, "absent"))).toBe(false);
  const missing = join(host.root, "missing-parent");
  expect(() => pluginHook(input(), "SessionStart", { ...envFor(), CLAUDE_ENV_FILE: join(missing, "env") })).toThrow();
  expect(existsSync(missing)).toBe(false);
  expect(readdirSync(f.root)).toEqual([]);
});
test("host environment writes reject relative paths and non-regular leaves without blocking", () => {
  expect(() => pluginHook(input(), "SessionStart", { ...envFor(), CLAUDE_ENV_FILE: "relative-env.sh" })).toThrow("must be absolute");
  const directory = join(host.root, "directory"); mkdirSync(directory);
  expect(() => pluginHook(input(), "SessionStart", { ...envFor(), CLAUDE_ENV_FILE: directory })).toThrow();
  const fifo = join(host.root, "fifo");
  expect(spawnSync("mkfifo", [fifo], { encoding: "utf8" }).status).toBe(0);
  expect(() => pluginHook(input(), "SessionStart", { ...envFor(), CLAUDE_ENV_FILE: fifo })).toThrow("must be regular");
  expect(readdirSync(directory)).toEqual([]); expect(readdirSync(f.root)).toEqual([]);
});
test("plugin lifecycle auto-enrolls only initialized projects without requiring project hooks", async () => {
  applyInstall(await planInstall(f.project, { autoJoin: true }));
  const context = { ...input(), agent_type: "custom-primary" }; pluginHook(context, "SessionStart", envFor());
  const store = new Store(f.project.room);
  try {
    const member = store.actor({ runtime: "claude", session: context.session_id });
    expect(state(f.project, member)?.active).toBe(true); expect(receiver(f.project, member).mode).toBe("claude-socket-experimental");
    pluginHook({ ...context, hook_event_name: "SessionEnd" }, "SessionEnd", envFor());
    expect(state(f.project, member)?.active).toBe(false);
  } finally { store.close(); }
  expect(existsSync(join(f.root, ".claude"))).toBe(false); expect(existsSync(join(f.root, "AGENTS.md"))).toBe(false);
});
test("auto-join opt-out and uninstall stop plugin enrollment", async () => {
  applyInstall(await planInstall(f.project, { autoJoin: false })); pluginHook(input(), "SessionStart", envFor());
  expect(existsSync(join(f.project.room, "chat.db"))).toBe(false);
  applyInstall(await planInstall(f.project, { uninstall: true }));
  expect(pluginHook(input(), "SessionStart", envFor())).toEqual({}); expect(existsSync(join(f.project.room, "chat.db"))).toBe(false);
});
test("auto-join off never enrolls a new UUID in an existing selected room or takes over a same-named member", async () => {
  applyInstall(await planInstall(f.project, { autoJoin: false })); createRoom(f.project, "review");
  const project = roomProject(f.project, "review"), context = input(), store = new Store(project.room);
  try {
    const generatedName = `claude-${new Bun.CryptoHasher("sha256").update(context.session_id).digest("hex").slice(0, 10)}`;
    const existing = store.join({ runtime: "claude", session: randomUUID() }, generatedName);
    selectRoom(project, { runtime: "claude", session: context.session_id });
    const before = readFileSync(join(project.room, "chat.db"));
    const result = pluginHook(context, "SessionStart", envFor());
    expect(JSON.stringify(result)).toContain("auto_join_disabled"); expect(store.members()).toEqual([existing]);
    expect(readFileSync(join(project.room, "chat.db"))).toEqual(before);
    expect(state(project, existing)).toBeNull(); expect(existsSync(join(f.project.room, "chat.db"))).toBe(false);
  } finally { store.close(); }
});
test("an existing shared-room identity cannot resume from an uninitialized worktree", async () => {
  git(f.root, ["init", "-b", "main"]);
  git(f.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const project = discoverProject(f.root); applyInstall(await planInstall(project, { autoJoin: false })); createRoom(project, "review");
  const selected = roomProject(project, "review"), store = new Store(selected.room), session = randomUUID();
  try {
    const member = store.join({ runtime: "claude", session }); selectRoom(selected, { runtime: "claude", session });
    saveState(selected, { session, memberId: member.id, active: false });
    const linked = join(f.root, "linked"); git(f.root, ["worktree", "add", "-b", "linked", linked]);
    const other = discoverProject(linked);
    expect(pluginHook({ session_id: session, cwd: linked, hook_event_name: "SessionStart" }, "SessionStart", envFor())).toEqual({});
    expect(existsSync(join(workspaceDir(other), "installed.json"))).toBe(false); expect(state(selected, member)?.active).toBe(false);
  } finally { store.close(); }
});
test("startup displays inbound user policy without changing it or overriding hold/refuse", async () => {
  applyInstall(await planInstall(f.project));
  const env = envFor(), directory = env.CLAUDE_CONFIG_DIR!; mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, "settings.json");
  for (const choice of ["accept", "hold", "refuse"]) {
    const before = JSON.stringify({ crossSessionInbound: choice, model: "keep" }); writeFileSync(path, before, { mode: 0o600 });
    const result = pluginHook(input(), "SessionStart", env);
    expect(result.systemMessage).toContain(choice === "accept" ? "accept peer messages automatically" : `${choice} peer messages`);
    expect(JSON.stringify(result)).toContain("effective native policy is unverified");
    expect(readFileSync(path, "utf8")).toBe(before);
  }
  writeFileSync(path, "{}");
  expect(pluginHook(input(), "SessionStart", env).systemMessage).toContain("may need your approval");
  expect(readFileSync(path, "utf8")).toBe("{}");
});
test("subagent startup never leaks identity to the primary shell or creates project state", () => {
  const path = join(host.root, "env"); writeFileSync(path, "", { mode: 0o600 });
  expect(pluginHook({ ...input(), agent_id: "child", agent_type: "custom-primary" }, "SessionStart", { ...envFor(), CLAUDE_ENV_FILE: path })).toEqual({});
  expect(readFileSync(path, "utf8")).toBe(""); expect(readdirSync(f.root)).toEqual([]);
});
test("plugin wrapper forwards stdin with spaces and apostrophes and needs no external runtime", () => {
  const directory = join(host.root, "bin with space's"); mkdirSync(directory);
  const capture = join(host.root, "capture");
  writeFileSync(join(directory, "agentchat"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$CAPTURE"\ncat >> "$CAPTURE"\n', { mode: 0o700 });
  const payload = JSON.stringify(input());
  const r = spawnSync("/bin/sh", [join(import.meta.dir, "../plugins/agentchat/scripts/hook.sh"), "session-start"],
    { input: payload, encoding: "utf8", env: { ...envFor(), PATH: "/usr/bin:/bin", HOME: host.root, AGENTCHAT_BIN_DIR: directory, CAPTURE: capture } });
  expect(r.status).toBe(0); expect(readFileSync(capture, "utf8")).toBe(`hook plugin-session-start\n${payload}`);
});
test("missing CLI is silent and plugin context follows native cwd rather than startup root", () => {
  const context = input();
  const r = spawnSync("/bin/sh", [join(import.meta.dir, "../plugins/agentchat/scripts/hook.sh"), "session-start"],
    { input: JSON.stringify(context), encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: host.root } });
  expect(r.status).toBe(0); expect(r.stdout).toBe(""); expect(readdirSync(f.root)).toEqual([]);
  const cli = spawnSync(process.execPath, [join(import.meta.dir, "../bin/agentchat"), "hook", "plugin-session-start"],
    { cwd: host.root, env: envFor(), input: JSON.stringify(context), encoding: "utf8" });
  expect(cli.status).toBe(0); expect(JSON.parse(cli.stdout)).toEqual({}); expect(readdirSync(f.root)).toEqual([]);
});
test("upgrading retires owned private Channel launchers without touching user launchers", async () => {
  mkdirSync(f.project.room, { mode: 0o700 });
  const old = join(f.project.room, "claude.command"); writeFileSync(old, '#!/bin/sh\n# AgentChat managed Claude entry. Host confirmations remain interactive.\nexit 0\n', { mode: 0o700 });
  mkdirSync(join(f.project.room, "launchers"), { mode: 0o700 });
  const own = join(f.project.room, "launchers/old.command"), user = join(f.project.room, "launchers/user.command");
  writeFileSync(own, readFileSync(old), { mode: 0o700 }); writeFileSync(user, "User launcher\n", { mode: 0o700 });
  applyInstall(await planInstall(f.project)); expect(spawnSync("/bin/sh", [old]).status).toBe(1);
  expect(readFileSync(own, "utf8")).toContain("retired"); expect(readFileSync(user, "utf8")).toBe("User launcher\n");
});
