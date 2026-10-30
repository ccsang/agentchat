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
const env = testEnv({ PATH: "/usr/bin:/bin", HOME: root, XDG_DATA_HOME: join(root, "data"), AGENTCHAT_BIN_DIR: join(root, "shared bin's"), CLAUDE_CONFIG_DIR: join(root, "claude-host") });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function run(command: string, args: string[], input?: string, extra: NodeJS.ProcessEnv = {}, cwd = project) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, input, encoding: "utf8", timeout: 15000 });
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
  const embedded = JSON.parse(run(program, ["skills", "get", "--json"]));
  assert(embedded.version === version && embedded.content.includes(`CLI version: ${version}`), "Standalone skill/version mismatch");
  assert(run(program, ["skills", "get"]) === embedded.content.trim(), "Standalone raw/JSON skills differ");
  assert(!existsSync(join(project, ".agentchat")), "Reading an embedded skill initialized the project");
  const setup = JSON.parse(run(program, ["setup"])), globalCli = setup.cli;
  assert(setup.program_installed && !setup.project_initialized && !existsSync(join(project, ".agentchat")), "Program setup initialized a project");
  const wrapper = readFileSync(globalCli, "utf8");
  writeFileSync(globalCli, "Unrelated user command\n");
  const conflict = spawnSync(program, ["setup"], { cwd: project, env, encoding: "utf8" });
  assert(conflict.status !== 0 && readFileSync(globalCli, "utf8") === "Unrelated user command\n", "Program setup overwrote an unrelated command");
  writeFileSync(globalCli, wrapper);
  const inboundPath = join(env.CLAUDE_CONFIG_DIR!, "settings.json");
  assert(JSON.parse(run(program, ["claude-inbound", "accept"])).applied === false && !existsSync(inboundPath), "Inbound preview wrote user settings");
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { mode: 0o700 });
  const originalInbound = '{"model":"preserve-user-model","permissions":{"deny":["Bash(curl:*)"]}}\n';
  writeFileSync(inboundPath, originalInbound, { mode: 0o600 });
  const inboundApplied = JSON.parse(run(program, ["claude-inbound", "accept", "--apply"]));
  assert(inboundApplied.applied && inboundApplied.configured === "accept" && !inboundApplied.reception_verified, "Compiled inbound setup failed or claimed reception");
  assert(readFileSync(inboundApplied.backup, "utf8") === originalInbound, "Inbound backup does not preserve exact original settings");
  assert(JSON.parse(readFileSync(inboundPath, "utf8")).permissions.deny[0] === "Bash(curl:*)", "Inbound setup overwrote unrelated permissions");
  const inboundTime = statSync(inboundPath).mtimeMs;
  assert(!JSON.parse(run(program, ["claude-inbound", "accept", "--apply"])).changed && statSync(inboundPath).mtimeMs === inboundTime, "Inbound setup is not idempotent");
  assert(!existsSync(join(project, ".agentchat")), "Inbound setup initialized a project");
  const pluginWrapper = resolve(import.meta.dir, "../plugins/agentchat/scripts/hook.sh"), nativeEnv = join(root, "native-env");
  const startupSession = randomUUID(), startup = JSON.stringify({ session_id: startupSession, cwd: project, hook_event_name: "SessionStart" });
  const compactEnv = join(root, "compact-env"), compact = JSON.stringify({ session_id: startupSession, cwd: project, hook_event_name: "SessionStart", source: "compact" });
  assert(run("/bin/sh", [pluginWrapper, "session-start"], compact, { CLAUDE_ENV_FILE: compactEnv }) === "{}", "Compact hook failed on a missing environment file");
  const compactIdentity = readFileSync(compactEnv, "utf8");
  assert(compactIdentity === `export AGENTCHAT_CLAUDE_SESSION_ID='${startupSession}'\n` && (statSync(compactEnv).mode & 0o777) === 0o600, "Compact identity file is missing, incorrect or not private");
  run("/bin/sh", [pluginWrapper, "session-start"], compact, { CLAUDE_ENV_FILE: compactEnv });
  assert(readFileSync(compactEnv, "utf8") === compactIdentity && !existsSync(join(project, ".agentchat")), "Repeated compact hook duplicated identity or initialized the project");
  writeFileSync(nativeEnv, "export USER_RULE='keep'\n", { mode: 0o600 });
  assert(run("/bin/sh", [pluginWrapper, "session-start"], startup, { CLAUDE_ENV_FILE: nativeEnv }) === "{}", "Plugin hook initialized an unrelated project");
  assert(!existsSync(join(project, ".agentchat")) && readFileSync(nativeEnv, "utf8").includes(startupSession), "Plugin identity is missing or startup wrote project state");
  const preview = invoke(["install"]);
  assert(preview.applied === false && !existsSync(join(project, ".agentchat")), "Preview mutated the project");
  const first = JSON.parse(run(globalCli, ["--project", project, "join", "--generic", "--name", "release-alice"]));
  assert(first.initialization.initialized, "First join did not initialize its project");
  assert(first.initialization.runtime_only && first.initialization.project_file_changes.length === 0, "First join requested project integration");
  run("/bin/sh", [pluginWrapper, "session-start"], startup);
  assert(!invoke(["members"]).members.some((member: { session_ref: string }) => member.session_ref === startupSession), "Plugin ignored auto-join opt-out");
  assert(invoke(["install", "--auto-join", "--apply"]).applied, "Auto-join configuration failed");
  const startupResult = JSON.parse(run("/bin/sh", [pluginWrapper, "session-start"], startup));
  assert(startupResult.hookSpecificOutput.additionalContext.includes(program), "Plugin context used an old pinned executable");
  assert(startupResult.systemMessage.includes("accept peer messages automatically"), "Startup did not display configured inbound policy");
  assert(invoke(["members"]).members.some((member: { session_ref: string }) => member.session_ref === startupSession), "Compiled plugin startup did not enroll the fixture session");
  run("/bin/sh", [pluginWrapper, "session-end"], JSON.stringify({ session_id: startupSession, cwd: project, hook_event_name: "SessionEnd" }));
  assert(JSON.parse(readFileSync(join(project, ".agentchat", "sessions", `${startupSession}.json`), "utf8")).active === false, "Compiled plugin SessionEnd did not clean up");
  assert(readFileSync(join(project, "AGENTS.md"), "utf8") === "Existing project instructions\n" && !existsSync(join(project, "CLAUDE.md")) && !existsSync(join(project, ".claude")), "Default join changed project instruction or hook files");
  const optional = invoke(["install", "--instructions", "--hooks"]);
  assert(optional.project_file_changes.length === 3 && !optional.applied && !existsSync(join(project, ".claude")), "Optional integration preview wrote project files");
  assert(invoke(["install", "--instructions", "--hooks", "--apply"]).applied, "Explicit integration failed");
  assert(!/\p{Script=Han}/u.test(readFileSync(join(project, "AGENTS.md"), "utf8")), "Generated project instructions are not English");
  const userFiles = ["AGENTS.md", "CLAUDE.md", ".claude/settings.local.json"].map(path => readFileSync(join(project, path), "utf8"));
  const programTime = statSync(program).mtimeMs;
  const room = join(project, ".agentchat"), entry = join(room, "run");
  assert(!existsSync(join(room, "agentchat.js")), "Standalone install unexpectedly needs a JS source bundle");
  assert(run(entry, ["--version"]) === version, "Installed entry needs a development runtime");
  assert(JSON.parse(run(entry, ["skills", "get", "--json"])).sha256 === embedded.sha256, "Pinned entry reads a different CLI's skill");
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
  assert(!existsSync(join(room, "claude.command")), "New installs still generate a Channel launcher");
  assert(invoke(["room", "create", "review"]).created, "Room creation failed");
  const selected = JSON.parse(run(globalCli, ["--project", project, "room", "use", "review"], undefined, host));
  assert(selected.room === "review" && selected.initialization.initialized === false, "Room selection reinstalled its project");
  run(globalCli, ["--project", project, "send", "--text", "review-room-only"], undefined, host);
  const named = JSON.parse(run(globalCli, ["--project", project, "read", "--new"], undefined, host));
  assert(named.room_name === "review" && named.messages[0].body === "review-room-only", "Named room routing failed");
  const back = JSON.parse(run(globalCli, ["--project", project, "room", "use", "default"], undefined, host));
  assert(back.member.id === native.member.id, "Switching back lost the original membership");
  const capture = join(root, "captured-notice"), fakeCodex = join(root, "fixture-codex");
  writeFileSync(fakeCodex, `#!/bin/sh
if [ "$1" = --version ]; then printf '%s\\n' 'codex-cli fixture'; exit 0; fi
if [ "$2" = --help ]; then printf '%s\\n' '--thread --message'; exit 0; fi
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --thread) notice_thread="$2"; shift 2 ;;
    --message) printf '%s' "$2" > "$AGENTCHAT_NOTICE_CAPTURE"; shift 2 ;;
    *) exit 1 ;;
  esac
done
printf 'Queued message compact123 for thread %s.\\n' "$notice_thread"
`, { mode: 0o700 });
  assert(invoke(["install", "--codex-bin", fakeCodex, "--apply"]).applied, "Fixture adapter setup failed");
  const queueHost = { CODEX_THREAD_ID: randomUUID() };
  const queueMember = JSON.parse(run(globalCli, ["--project", project, "room", "use", "review"], undefined, queueHost)).member;
  const notified = JSON.parse(run(globalCli, ["--project", project, "--room", "review", "send", "--to", queueMember.id,
    "--id", "compact-release", "--text", "Standalone notification business body", "--notify"], undefined, { ...host, AGENTCHAT_NOTICE_CAPTURE: capture }));
  assert(notified.notification.state === "submitted", "Fixture queue did not accept compact notice");
  const notice = readFileSync(capture, "utf8"), lines = notice.split("\n");
  assert(lines.length === 3 && lines[0]!.includes("not user approval") && !notice.includes("Standalone notification business body"), "Notice is verbose or carries business text");
  const readArgv = JSON.parse(lines.find(line => line.startsWith("Read argv: "))!.slice("Read argv: ".length)) as string[];
  run(globalCli, ["--project", project, "room", "use", "default"], undefined, queueHost);
  const received = JSON.parse(run(readArgv[0]!, readArgv.slice(1), undefined, queueHost, root));
  assert(received.room_name === "review" && received.messages.some((message: { id: string }) => message.id === "compact-release"), "Delayed compact notice read another room or cwd");
  assert(JSON.parse(run(globalCli, ["--project", project, "room", "current"], undefined, queueHost)).current === "default", "Compact notice changed room selection");
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
  assert(JSON.parse(readFileSync(inboundPath, "utf8")).crossSessionInbound === "accept", "Project uninstall unexpectedly changed the separate user inbound choice");
  assert(JSON.parse(run(program, ["claude-inbound", "hold", "--apply"])).configured === "hold", "Compiled hold setup failed");
  assert(JSON.parse(run(program, ["claude-inbound", "refuse", "--apply"])).configured === "refuse", "Compiled refuse setup failed");
  assert(JSON.parse(run(program, ["claude-inbound", "default", "--apply"])).configured === null, "Compiled default reversal failed");
  assert(JSON.stringify(JSON.parse(readFileSync(inboundPath, "utf8"))) === JSON.stringify(JSON.parse(originalInbound)), "Reversing inbound setup removed unrelated settings");
  const afterUninstall = randomUUID();
  assert(run("/bin/sh", [pluginWrapper, "session-start"], JSON.stringify({ session_id: afterUninstall, cwd: project, hook_event_name: "SessionStart" })) === "{}", "Plugin enrolled an uninstalled workspace");
  console.log(JSON.stringify({ ok: true, version, platform: process.platform, arch: process.arch,
    checks: ["no_source_checkout", "no_external_bun", "no_dotenv_or_preload", "embedded_version_matched_skill", "program_setup_once", "preserve_unrelated_command", "inbound_preview_no_writes", "inbound_exact_backup_and_preserved_settings", "inbound_idempotency_and_reversal", "startup_inbound_policy_notice", "generated_english_instructions", "plugin_hooks_no_unrelated_initialization", "plugin_hooks_auto_join_and_cleanup", "plugin_hooks_opt_out_and_uninstall", "preview", "local_only_first_join", "explicit_optional_integration", "later_join_preserves_project", "named_rooms_without_reinstall", "compact_three_line_notification", "compact_routing_after_room_switch_from_other_cwd", "idempotency", "hooks", "no_channel_launcher", "sqlite_send_read_mark", "uninstall_preserves_history"],
    native_reception_verified: false }));
} finally { rmSync(root, { recursive: true, force: true }); }
