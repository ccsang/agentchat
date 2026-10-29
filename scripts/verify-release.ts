import { parseArgs } from "node:util";
import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { version } from "../package.json";
import { testEnv } from "../tests/helpers.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
if (!values.binary) throw new Error("Pass --binary with a native release executable");
const root = realpathSync(mkdtempSync(join(tmpdir(), "agentchat-release-")));
const program = join(root, "tools with space's", "agentchat"), project = join(root, "new project's directory");
const env = testEnv({ PATH: "/usr/bin:/bin", HOME: root, XDG_DATA_HOME: join(root, "data"), AGENTCHAT_BIN_DIR: join(root, "shared bin's") });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function run(command: string, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, { cwd: project, env: { ...env, ...extra }, input, encoding: "utf8", timeout: 15000 });
  assert(result.status === 0, `${command}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const invoke = (args: string[]) => JSON.parse(run(program, ["--project", project, ...args]));
try {
  mkdirSync(join(root, "tools with space's")); mkdirSync(project);
  copyFileSync(resolve(values.binary), program); chmodSync(program, 0o700);
  writeFileSync(join(project, "AGENTS.md"), "Existing project instructions\n");
  writeFileSync(join(project, ".env"), "CODEX_THREAD_ID=00000000-0000-0000-0000-000000000000\n");
  writeFileSync(join(project, "bunfig.toml"), 'preload = ["./missing-preload-must-not-run.ts"]\n');
  assert(run(program, ["--version"]) === version, "Version mismatch");
  assert(run(program, ["--help"]).includes("AgentChat"), "Missing help");
  const setup = JSON.parse(run(program, ["setup"])), globalCli = setup.cli;
  assert(setup.program_installed && !setup.project_initialized && !existsSync(join(project, ".agentchat")), "Program setup initialized a project");
  const wrapper = readFileSync(globalCli, "utf8");
  writeFileSync(globalCli, "Unrelated user command\n");
  const conflict = spawnSync(program, ["setup"], { cwd: project, env, encoding: "utf8" });
  assert(conflict.status !== 0 && readFileSync(globalCli, "utf8") === "Unrelated user command\n", "Program setup overwrote an unrelated command");
  writeFileSync(globalCli, wrapper);
  const preview = invoke(["install"]);
  assert(preview.applied === false && !existsSync(join(project, ".agentchat")), "Preview mutated the project");
  const first = JSON.parse(run(globalCli, ["--project", project, "join", "--generic", "--name", "release-alice"]));
  assert(first.initialization.initialized, "First join did not initialize its project");
  const userFiles = ["AGENTS.md", "CLAUDE.md", ".claude/settings.local.json"].map(path => readFileSync(join(project, path), "utf8"));
  const programTime = statSync(program).mtimeMs;
  const room = join(project, ".agentchat"), entry = join(room, "run");
  assert(!existsSync(join(room, "agentchat.js")), "Standalone install unexpectedly needs a JS source bundle");
  assert(run(entry, ["--version"]) === version, "Installed entry needs a development runtime");
  assert(invoke(["install"]).changes.length === 0, "Repeated installation is not idempotent");
  const settings = JSON.parse(readFileSync(join(project, ".claude/settings.local.json"), "utf8"));
  const hook = settings.hooks.SessionStart[0].hooks[0];
  assert(hook.command === program && hook.args[0] === "--project", "Hook still launches a Bun script");
  const session = randomUUID();
  run(hook.command, hook.args, JSON.stringify({ session_id: session, cwd: project, hook_event_name: "SessionStart" }));
  const host = { AGENTCHAT_CLAUDE_SESSION_ID: session };
  const native = JSON.parse(run(globalCli, ["--project", project, "join"], undefined, host));
  assert(native.initialization.initialized === false, "A new session reinitialized its project");
  const members = invoke(["members"]).members;
  const claude = members.find((member: { session_ref: string }) => member.session_ref === session);
  assert(claude, "Compiled hook did not register its synthetic fixture session");
  const launcher = invoke(["channel-config", "--to", claude.id]);
  assert(launcher.script.includes("tools with space") && !launcher.script.includes("agentchat.js"), "Launcher depends on source/Bun");
  assert(invoke(["room", "create", "review"]).created, "Room creation failed");
  const selected = JSON.parse(run(globalCli, ["--project", project, "room", "use", "review"], undefined, host));
  assert(selected.room === "review" && selected.initialization.initialized === false, "Room selection reinstalled its project");
  run(globalCli, ["--project", project, "send", "--text", "review-room-only"], undefined, host);
  const named = JSON.parse(run(globalCli, ["--project", project, "read", "--new"], undefined, host));
  assert(named.room_name === "review" && named.messages[0].body === "review-room-only", "Named room routing failed");
  const back = JSON.parse(run(globalCli, ["--project", project, "room", "use", "default"], undefined, host));
  assert(back.member.id === native.member.id, "Switching back lost the original membership");
  assert(["AGENTS.md", "CLAUDE.md", ".claude/settings.local.json"].every((path, i) => readFileSync(join(project, path), "utf8") === userFiles[i]), "Room switching rewrote project configuration");
  assert(statSync(program).mtimeMs === programTime, "Project operations replaced the installed program");
  const alice = first.member;
  const bob = invoke(["join", "--generic", "--name", "release-bob"]).member;
  const sent = invoke(["send", "--as", alice.id, "--to", bob.id, "--text", "standalone fixture"]);
  assert(sent.ok, "SQLite send failed");
  const page = JSON.parse(run(entry, ["read", "--as", bob.id, "--new"]));
  assert(page.messages.length === 1 && page.messages[0].body === "standalone fixture", "SQLite read failed");
  const mark = JSON.parse(run(entry, ["read", "--as", bob.id, "--mark", String(page.next_cursor)]));
  assert(mark.read_seq === page.next_cursor, "Explicit mark failed");
  assert(invoke(["uninstall", "--apply"]).applied, "Uninstall failed");
  assert(readFileSync(join(project, "AGENTS.md"), "utf8") === "Existing project instructions\n", "Uninstall removed user instructions");
  assert(existsSync(join(room, "chat.db")), "Uninstall deleted history");
  console.log(JSON.stringify({ ok: true, version, platform: process.platform, arch: process.arch,
    checks: ["no_source_checkout", "no_external_bun", "no_dotenv_or_preload", "program_setup_once", "preserve_unrelated_command", "preview", "first_join_initializes", "later_join_preserves_project", "named_rooms_without_reinstall", "idempotency", "hooks", "launcher", "sqlite_send_read_mark", "uninstall_preserves_history"],
    native_reception_verified: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
