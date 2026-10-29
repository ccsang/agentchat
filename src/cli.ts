import { parseArgs } from "node:util";
import { version } from "../package.json";
import { baseProject, discoverProject } from "./project.ts";
import { identify, optionalIdentity } from "./identity.ts";
import { Store } from "./store.ts";
import { errorResult, requireThat } from "./errors.ts";
import { receiver, reportChannelUnavailable, state } from "./runtime.ts";
import { notifyMember, paused, resume } from "./notify.ts";
import { applyInstall, channelConfig, ensureProject, planInstall, preview } from "./install.ts";
import { endHook, registerHook, waitHook } from "./hooks.ts";
import type { HookInput } from "./hooks.ts";
import type { Identity, Member, Project } from "./types.ts";
import { recordProbeReply, startProbe } from "./probe.ts";
import { launchClaude } from "./launch.ts";
import { waitForLaunchHost } from "./binding.ts";
import { configureSocket } from "./socket-state.ts";
import { socketBinding } from "./socket-state.ts";
import { createRoom, legacyMember, listRooms, resolveRoom, roomExists, roomName, selectRoom, withRoomSelection } from "./rooms.ts";
import { setupProgram } from "./program.ts";
import { getSkill, listSkills } from "./skills.ts";

const HELP = `AgentChat ${version}
Local project chat for coding agents. Output is JSON except help, version and skills get.

Skills (read-only, no project or native identity required):
  skills list                        List embedded skills and this CLI's version.
  skills get [agentchat] [--json]     Read the full protocol bundled with this executable.

Daily commands (project and native identity are discovered automatically):
  join [--room NAME] [--name NAME]    Join/select a room; prepare local state without changing project files.
  room create NAME                   Create a room without reinstalling the program or project.
  room list | current                Inspect rooms without changing selection.
  room use NAME                      Join/select an existing room for this native session only.
  members                            List registered members; no inferred online status.
  send [--to NAME|ID | --reply-to ID] [--notify] [--id ID] --text TEXT
  send [--to NAME|ID | --reply-to ID] [--notify] [--id ID] --stdin
  read [--new | --after SEQ | --id ID | --mark SEQ] [--limit 20]

Setup / diagnostics:
  install [--instructions] [--hooks] [--apply] [--auto-join | --no-auto-join] [--budget N] [--window-seconds N] [--codex-bin PATH]
                                     Default: local runtime only. Optional flags explicitly enable project integration.
  uninstall [--instructions] [--hooks] [--apply]  Remove selected integration, or disable all; keep history.
  doctor                             Report current identity and receiver evidence.
  probe [--to NAME|ID]                Native nonce probe; may use model quota.
  notify resume [--to NAME|ID]        Resume future notifications, never reset old attempts.
  notify unavailable [--to NAME|ID]   Record an observed native Channel-unavailable status.
  notify claude-channel              Session-owned one-way MCP Channel; launched by Claude.
  channel-config [--to NAME|ID] [--apply]  Prepare an exact-session Claude resume launcher.
  socket-config [--to NAME|ID] [--apply] [--disable]  Opt in/out of the version-locked native socket experiment.
  launch claude [--to NAME|ID]        User-terminal entry; host consent remains interactive.

Advanced / testing: --project DIR, --room NAME, --as MEMBER; join --generic --name NAME.
Explicit --room on read/send/mark routes that command only, without changing session selection.
Normal onboarding never requires the user to copy these parameters or a native UUID.
`;

async function joinProject(project: Project, identity: Identity, name?: string): Promise<Record<string, unknown>> {
  return withRoomSelection(project, identity, async () => {
    if (identity.runtime === "claude" && roomName(project) !== "default") {
      const old = legacyMember(project, { runtime: identity.runtime, session_ref: identity.session } as Member);
      if (old && state(baseProject(project), old)?.listener?.routingVersion !== 2 && !socketBinding(project, old)?.enabled) {
        requireThat(!receiver(baseProject(project), old).transport_alive, "E_RECEIVER", "The older Channel cannot switch rooms; restore this session through the updated project launcher first");
      }
    }
    const initialization = await ensureProject(project);
    requireThat(roomName(project) === "default" || roomExists(project), "E_ROOM", "Room no longer exists");
    const store = new Store(project.room, { create: roomName(project) === "default" });
    try {
      const member = store.join(identity, name);
      selectRoom(project, identity);
      return { ok: true, joined: true, project, room: roomName(project), member, members: store.members(), initialization, reception: receiver(project, member) };
    } finally { store.close(); }
  });
}

async function stdin(limit: number): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length; requireThat(size <= limit, "E_SIZE", "Input is too large"); chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  requireThat(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), "E_USAGE", `${name} must be an integer`); return Number(value);
}
export async function runCli(args: readonly string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { console.log(HELP); return 0; }
  if (args.length === 1 && ["--version", "-v", "version"].includes(args[0]!)) { console.log(version); return 0; }
  // Hook configuration/argument failures must exit 1, never the asyncRewake signal 2.
  let hook = args.some(arg => arg.startsWith("--agentchat-managed="));
  let store: Store | undefined;
  try {
    if (args[0] === "setup") {
      requireThat(args.length === 1, "E_USAGE", "Program setup takes no project or session arguments");
      console.log(JSON.stringify(setupProgram())); return 0;
    }
    const { values: v, positionals: p } = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: {
      project: { type: "string" }, room: { type: "string" }, as: { type: "string" }, name: { type: "string" },
      generic: { type: "boolean" }, to: { type: "string" }, "reply-to": { type: "string" }, notify: { type: "boolean" },
      id: { type: "string" }, text: { type: "string" }, stdin: { type: "boolean" }, new: { type: "boolean" },
      after: { type: "string" }, limit: { type: "string" }, mark: { type: "string" }, json: { type: "boolean" },
      apply: { type: "boolean" }, instructions: { type: "boolean" }, hooks: { type: "boolean" }, disable: { type: "boolean" }, "auto-join": { type: "boolean" }, "no-auto-join": { type: "boolean" }, budget: { type: "string" },
      "window-seconds": { type: "string" }, "codex-bin": { type: "string" }, "agentchat-managed": { type: "string" },
    } });
    const command = p[0]; hook = command === "hook";
    if (command === "skills") {
      for (const key of Object.keys(v)) requireThat(["project", "json"].includes(key), "E_USAGE", `--${key} is not valid for skills`);
      if (p[1] === "list" && p.length === 2) console.log(JSON.stringify(listSkills()));
      else {
        requireThat(p[1] === "get" && (p.length === 2 || p.length === 3), "E_USAGE", "Use skills list or skills get [agentchat] [--json]");
        const skill = getSkill(p[2]);
        if (v.json) console.log(JSON.stringify(skill)); else process.stdout.write(skill.content);
      }
      return 0;
    }
    requireThat(p.length === (command === "room" ? p[1] === "create" || p[1] === "use" ? 3 : 2 : hook || command === "notify" || command === "launch" ? 2 : 1), "E_USAGE", "Unexpected positional arguments");
    const specific: Record<string, string[]> = {
      join: ["name", "generic"], room: [], members: [], send: ["to", "reply-to", "notify", "id", "text", "stdin"],
      read: ["new", "after", "id", "mark", "limit"], install: ["apply", "instructions", "hooks", "auto-join", "no-auto-join", "budget", "window-seconds", "codex-bin"],
      uninstall: ["apply", "instructions", "hooks"], doctor: [], probe: ["to"], notify: ["to"], hook: ["agentchat-managed"], "channel-config": ["apply", "to"], "socket-config": ["apply", "to", "disable"], launch: ["to"],
    };
    const allowed = new Set(["project", "room", "as", "json", ...(specific[command ?? ""] ?? [])]);
    for (const key of Object.keys(v)) requireThat(allowed.has(key), "E_USAGE", `--${key} is not valid for ${command}`);
    const base = discoverProject(v.project ?? process.cwd());
    requireThat(!v.room || !["room", "install", "uninstall", "hook"].includes(command ?? ""), "E_USAGE", "Project setup and room management do not take --room; use room use NAME");
    const physical = command === "install" || command === "uninstall" || command === "hook" || command === "room" || command === "notify" && p[1] === "claude-channel";
    const identity = command === "join" ? v.generic ? { runtime: "generic" as const, session: null } : identify() : physical ? undefined : optionalIdentity();
    requireThat(!v.room || !physical, "E_USAGE", "Project hooks and the Channel follow session room selection; they do not accept --room");
    const project = physical ? base : resolveRoom(base, v.room, identity);
    let result: unknown;
    if (command === "room") {
      requireThat(!v.as, "E_IDENTITY", "Room selection uses the current native session, not a supplied member profile");
      if (p[1] === "create") result = createRoom(base, p[2]!);
      else if (p[1] === "list" || p[1] === "current") result = listRooms(base, optionalIdentity());
      else if (p[1] === "use") result = await joinProject(resolveRoom(base, p[2]!, identify()), identify());
      else requireThat(false, "E_USAGE", "Use room create NAME, room list, room current or room use NAME");
    } else if (command === "install" || command === "uninstall") {
      requireThat(!(v["auto-join"] && v["no-auto-join"]), "E_USAGE", "Choose auto-join or no-auto-join");
      const plan = await planInstall(project, { uninstall: command === "uninstall", instructions: v.instructions, hooks: v.hooks, autoJoin: v["no-auto-join"] ? false : v["auto-join"],
        budget: number(v.budget, "budget"), windowSeconds: number(v["window-seconds"], "window-seconds"), codexBin: v["codex-bin"] });
      result = v.apply ? applyInstall(plan) : preview(plan);
    } else if (command === "launch") {
      requireThat(p[1] === "claude" && !v.as, "E_USAGE", "Use launch claude with an optional exact --to member");
      let member: Member | undefined;
      if (v.to) { store = new Store(project.room, { readonly: true }); member = store.member(v.to);
        requireThat(member.runtime === "claude", "E_IDENTITY", "The resume target must be a registered Claude session"); }
      return await launchClaude(project, member);
    } else if (command === "notify" && p[1] === "claude-channel") {
      requireThat(!v.as && !v.to, "E_IDENTITY", "A Channel binds through its own native SessionStart handshake, never a supplied member profile");
      const { runChannel } = await import("./channel.ts"); await runChannel(project); return 0;
    } else if (hook) {
      const input = JSON.parse(await stdin(64 * 1024)) as HookInput;
      if (p[1] === "session-start") { await waitForLaunchHost(project, process.env); result = registerHook(project, input, process.env); }
      else if (p[1] === "session-end") { endHook(project, input); return 0; }
      else if (p[1] === "wait") {
        const cancel = new AbortController();
        const stop = () => cancel.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
        try { const waited = await waitHook(project, input, cancel.signal); if (waited.text) console.error(waited.text); return waited.exitCode; }
        finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
      } else requireThat(false, "E_USAGE", "Unknown hook action");
    } else if (command === "doctor") {
      let identity: unknown;
      try { identity = identify(); } catch (error) { identity = errorResult(error); }
      let member: Member | null = null, diagnostic: unknown = null;
      try { store = new Store(project.room, { readonly: true }); member = v.as ? store.member(v.as) : store.actor(identify()); } catch (error) { diagnostic = errorResult(error); }
      result = { ok: true, project, identity, joined: !!member, member, diagnostic, reception: member ? receiver(project, member) : null };
    } else {
      requireThat(["join", "members", "send", "read", "notify", "probe", "channel-config", "socket-config"].includes(command ?? ""), "E_USAGE", "Unknown command; use --help");
      if (command === "join") {
        requireThat(!v.generic || v.name, "E_IDENTITY", "Generic shell enrollment requires an explicit name");
        result = await joinProject(project, identity!, v.name);
      } else {
        const writable = command === "send" || command === "probe" || command === "notify" || v.mark !== undefined;
        store = new Store(project.room, { readonly: !writable });
        const actor = (requireSelf = false) => {
          const member = v.as ? store!.member(v.as) : store!.actor(identify());
          if (requireSelf && member.runtime !== "generic") {
            const host = identify();
            requireThat(host.runtime === member.runtime && host.session === member.session_ref, "E_IDENTITY", "Native writes must use the current host session, not another member's profile");
          }
          return member;
        };
        if (command === "members") result = { ok: true, project, members: store.members() };
        else if (command === "send") {
          requireThat((v.text !== undefined) !== !!v.stdin, "E_USAGE", "Provide exactly one of --text or --stdin");
          const sent = store.send({ from: actor(true).id, to: v.to, replyTo: v["reply-to"], body: v.stdin ? await stdin(8192) : v.text!, notify: v.notify, id: v.id });
          let notification: unknown = { state: "not_requested" };
          try {
            if (sent.message.reply_to?.startsWith("probe-")) recordProbeReply(store, project, sent.message, identify());
            if (sent.message.notify) notification = sent.reused ? { state: "not_retried", reason: "Idempotent resend never repeats a notification attempt" } : await notifyMember(store, project, store.member(sent.message.to_id!));
          } catch (error) { notification = { state: "unknown", diagnostic: errorResult(error) }; }
          result = { ok: true, stored: true, message_id: sent.message.id, seq: sent.message.seq, reused: sent.reused, notify_requested: !!sent.message.notify, notification };
        } else if (command === "read") {
          requireThat([v.new, v.after !== undefined, v.id !== undefined, v.mark !== undefined].filter(Boolean).length <= 1, "E_USAGE", "Choose one read mode");
          const me = actor(v.mark !== undefined);
          if (v.id) result = { ok: true, message: store.message(v.id) };
          else if (v.mark !== undefined) result = { ok: true, read_seq: store.mark(me.id, number(v.mark, "mark")!) };
          else result = { ok: true, ...store.read(number(v.after, "after") ?? me.read_seq, number(v.limit, "limit")) };
        } else if (command === "probe") result = await startProbe(store, project, v.to ? store.member(v.to) : actor());
        else if (command === "channel-config") result = channelConfig(project, v.to ? store.member(v.to) : actor(), !!v.apply);
        else if (command === "socket-config") result = configureSocket(project, v.to ? store.member(v.to) : actor(), !!v.apply, !!v.disable);
        else if (command === "notify") {
          const me = v.to ? store.member(v.to) : actor();
          if (p[1] === "resume") { resume(project, me); result = { ok: true, resumed: me.id, old_reservations_preserved: true }; }
          else if (p[1] === "unavailable") { reportChannelUnavailable(project, me); result = { ok: true, reception: receiver(project, me), old_reservations_preserved: true }; }
          else if (p[1] === "status") result = { ok: true, reception: receiver(project, me), paused: paused(project, me) };
          else requireThat(false, "E_USAGE", "Unknown notification action");
        }
      }
    }
    if (!physical && result && typeof result === "object") result = { ...result, room_name: roomName(project) };
    console.log(JSON.stringify(result)); return 0;
  } catch (error) { console.error(JSON.stringify(errorResult(error))); return hook ? 1 : 2; }
  finally { store?.close(); }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
