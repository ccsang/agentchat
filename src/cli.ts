import { parseArgs } from "node:util";
import { version } from "../package.json";
import { discoverProject } from "./project.ts";
import { identify, optionalIdentity } from "./identity.ts";
import { Store } from "./store.ts";
import { errorResult, requireThat } from "./errors.ts";
import { policy, receiver, saveState, state } from "./runtime.ts";
import { inspectCodex, notifyMember, paused, resume } from "./notify.ts";
import { applyInstall, ensureProject, planInstall, preview } from "./install.ts";
import { endHook, pluginHook, registerHook, waitHook } from "./hooks.ts";
import type { HookInput } from "./hooks.ts";
import type { Identity, Member, Project } from "./types.ts";
import { recordProbeReply, startProbe } from "./probe.ts";
import { automaticSocket, configureSocket } from "./socket-state.ts";
import { createRoom, describeMembers, leaveSelectedRoom, listRooms, memberLeft, rejoinRoom, resolveRoom, roomExists, roomName, selectedRoom, selectRoom, withRoomSelection } from "./rooms.ts";
import { setupProgram } from "./program.ts";
import { getSkill, listSkills } from "./skills.ts";
import { applyClaudeInbound, claudeInboundStatus, INBOUND_CHOICES, planClaudeInbound, previewClaudeInbound } from "./claude-inbound.ts";
import type { InboundChoice } from "./claude-inbound.ts";

const HELP = `AgentChat ${version}
Local project chat for coding agents. Output is JSON except help, version and skills get.

Skills (read-only, no project or native identity required):
  skills list                        List embedded skills and this CLI's version.
  skills get [agentchat] [--json]     Read the full protocol bundled with this executable.

Daily commands (project and native identity are discovered automatically):
  join [--room NAME] [--name NAME]    Join/select a room; prepare local state without changing project files.
  leave                              Leave this session's selected room; preserve history and cursors.
  room create NAME                   Create a room without reinstalling the program or project.
  room list | current                Inspect rooms without changing selection.
  room use NAME                      Join/select an existing room for this native session only.
  members                            List registered members; no inferred online status.
  send [--to NAME|ID | --reply-to ID] [--notify] [--id ID] --text TEXT
  send [--to NAME|ID | --reply-to ID] [--notify] [--id ID] --stdin
  read [--new | --after SEQ | --id ID | --mark SEQ] [--limit 20]

Setup / diagnostics:
  claude-inbound [accept|hold|refuse|default] [--apply]
                                     Inspect/preview Claude user-level inbound policy; explicit apply backs up settings.
  install [--instructions] [--hooks] [--apply] [--auto-join | --no-auto-join] [--budget N] [--window-seconds N] [--codex-bin PATH]
                                     Default: local runtime only. Optional flags explicitly enable project integration.
  uninstall [--instructions] [--hooks] [--apply]  Remove selected integration, or disable all; keep history.
  doctor                             Report current identity and receiver evidence.
  probe [--to NAME|ID]                Native nonce probe; may use model quota.
  notify status [--to NAME|ID]        Show receiver evidence and any notification pause.
  notify resume [--to NAME|ID]        Resume future notifications, never reset old attempts.
  socket-config [--to NAME|ID] [--apply] [--disable]  Rebind/disable the native Claude socket (Claude Code 2.1.312+).

Advanced / testing: --project DIR, --room NAME, --as MEMBER; join --generic --name NAME.
Explicit --room on read/send/mark routes that command only, without changing session selection.
Normal onboarding never requires the user to copy these parameters or a native UUID.
`;

async function joinProject(project: Project, identity: Identity, name?: string): Promise<Record<string, unknown>> {
  return withRoomSelection(project, identity, async () => {
    const initialization = await ensureProject(project);
    requireThat(roomName(project) === "default" || roomExists(project), "E_ROOM", "Room no longer exists");
    const store = new Store(project.room, { create: roomName(project) === "default" });
    try {
      const member = store.join(identity, name);
      selectRoom(project, identity);
      const automatic = member.runtime === "claude" ? automaticSocket(project, member) : undefined;
      if (automatic) saveState(project, { ...state(project, member), session: member.session_ref!, active: true, memberId: member.id,
        error: automatic.state === "unavailable" ? { reason: String(automatic.reason), code: automatic.code as string | undefined, at: Date.now() } : undefined });
      return { ok: true, joined: true, project, room: roomName(project), member, members: describeMembers(project, store.members()), initialization, automatic_reception: automatic, reception: receiver(project, member) };
    } finally { store.close(); }
  });
}

async function leaveProject(project: Project, identity: Identity): Promise<Record<string, unknown>> {
  // Refuse an unrelated/unjoined project without initializing runtime state.
  const before = selectedRoom(project, identity);
  if (before === null) return { ok: true, left: false, room: null, selected_room: null };
  requireThat(roomExists(resolveRoom(project, before)), "E_NOT_JOINED", "This native session has not joined its selected room");
  return withRoomSelection(project, identity, async () => {
    const selected = selectedRoom(project, identity);
    if (selected === null) return { ok: true, left: false, room: null, selected_room: null };
    const room = resolveRoom(project, selected);
    requireThat(roomExists(room), "E_NOT_JOINED", "This native session has not joined its selected room");
    const store = new Store(room.room, { readonly: true });
    try {
      const member = store.actor(identity);
      leaveSelectedRoom(room, identity);
      return { ok: true, left: true, room: selected, selected_room: null, member_id: member.id,
        history_preserved: true, note: "Already submitted notifications may still arrive. Explicitly join to participate again." };
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
    requireThat(command !== "channel-config" && command !== "launch" && !(command === "notify" && ["claude-channel", "unavailable"].includes(p[1] ?? "")),
      "E_RETIRED", "Channel and its launchers are retired. Claude uses native socket reception; run join and doctor");
    if (hook && ["plugin-session-start", "plugin-session-end"].includes(p[1] ?? "")) {
      requireThat(p.length === 2 && Object.keys(v).every(key => key === "agentchat-managed"), "E_USAGE", "Plugin hooks use only native stdin context");
      const input = JSON.parse(await stdin(64 * 1024)) as HookInput;
      console.log(JSON.stringify(pluginHook(input, p[1] === "plugin-session-start" ? "SessionStart" : "SessionEnd", process.env))); return 0;
    }
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
    if (command === "claude-inbound") {
      requireThat(p.length <= 2 && Object.keys(v).every(key => ["apply", "json"].includes(key)), "E_USAGE", "claude-inbound takes only a policy and --apply; it changes user settings, not a project or room");
      requireThat(!v.apply || p.length === 2, "E_USAGE", "Choose accept, hold, refuse or default before --apply");
      if (p.length === 1) console.log(JSON.stringify(claudeInboundStatus()));
      else {
        requireThat(INBOUND_CHOICES.includes(p[1] as InboundChoice), "E_USAGE", "Use claude-inbound [accept|hold|refuse|default] [--apply]");
        const plan = planClaudeInbound(p[1] as InboundChoice);
        console.log(JSON.stringify(v.apply ? applyClaudeInbound(plan) : previewClaudeInbound(plan)));
      }
      return 0;
    }
    requireThat(p.length === (command === "room" ? p[1] === "create" || p[1] === "use" ? 3 : 2 : hook || command === "notify" ? 2 : 1), "E_USAGE", "Unexpected positional arguments");
    const specific: Record<string, string[]> = {
      join: ["name", "generic"], leave: [], room: [], members: [], send: ["to", "reply-to", "notify", "id", "text", "stdin"],
      read: ["new", "after", "id", "mark", "limit"], install: ["apply", "instructions", "hooks", "auto-join", "no-auto-join", "budget", "window-seconds", "codex-bin"],
      uninstall: ["apply", "instructions", "hooks"], doctor: [], probe: ["to"], notify: ["to"], hook: ["agentchat-managed"], "socket-config": ["apply", "to", "disable"],
    };
    const allowed = new Set(["project", "room", "as", "json", ...(specific[command ?? ""] ?? [])]);
    for (const key of Object.keys(v)) requireThat(allowed.has(key), "E_USAGE", `--${key} is not valid for ${command}`);
    const base = discoverProject(v.project ?? process.cwd());
    requireThat(!v.room || !["room", "install", "uninstall", "hook", "leave"].includes(command ?? ""), "E_USAGE", "Project setup, room management and leave do not take --room; use room use NAME");
    const physical = command === "install" || command === "uninstall" || command === "hook" || command === "room" || command === "leave";
    const identity = command === "join" ? v.generic ? { runtime: "generic" as const, session: null } : identify() : physical ? undefined : optionalIdentity();
    requireThat(!v.room || !physical, "E_USAGE", "This command follows session room selection and does not accept --room");
    if (command === "doctor" && !v.room && identity && selectedRoom(base, identity) === null) {
      console.log(JSON.stringify({ ok: true, project: base, identity, joined: false, member: null,
        diagnostic: { code: "E_NOT_JOINED", reason: "This session left its room; explicitly join to participate again." }, reception: null, room_name: null }));
      return 0;
    }
    const selector = v.room ?? (command === "join" && identity ? rejoinRoom(base, identity) : undefined);
    const project = physical ? base : resolveRoom(base, selector, identity);
    let result: unknown;
    if (command === "leave") {
      requireThat(!v.as, "E_IDENTITY", "Leave uses the current native session, not a supplied member profile");
      result = await leaveProject(base, identify());
    } else if (command === "room") {
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
    } else if (hook) {
      const input = JSON.parse(await stdin(64 * 1024)) as HookInput;
      if (p[1] === "session-start") { result = registerHook(project, input, process.env); }
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
      let claudeInbound: unknown;
      if (member?.runtime === "claude") {
        try { claudeInbound = claudeInboundStatus(); } catch (error) { claudeInbound = errorResult(error); }
      }
      const left = member ? memberLeft(project, member) : false;
      let reception = member ? receiver(project, member) : null;
      if (member?.runtime === "codex") {
        let transport: Record<string, unknown>;
        try {
          const queue = inspectCodex(policy(project).codexBin);
          transport = { state: queue ? "available" : "unavailable", scope: "command_capability", exact_session_reachable: null,
            host_version: queue?.version ?? null,
            reason: queue ? "A compatible queue command is available; exact-session reachability and model processing are not established."
              : "No compatible native queue command was found; no notification was sent." };
        } catch { transport = { state: "unknown", scope: "command_capability", exact_session_reachable: null, reason: "Queue capability configuration could not be inspected." }; }
        reception = { ...reception, transport };
      }
      result = { ok: true, project, identity, joined: !!member && !left, member: member ? { ...member, membership: left ? "left" : "joined" } : null, diagnostic, reception,
        ...(claudeInbound ? { claude_inbound: claudeInbound } : {}) };
    } else {
      requireThat(["join", "members", "send", "read", "notify", "probe", "socket-config"].includes(command ?? ""), "E_USAGE", "Unknown command; use --help");
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
          if (requireSelf) requireThat(!memberLeft(project, member), "E_NOT_JOINED", "This session left the room; explicitly rejoin before writing or marking messages");
          return member;
        };
        if (command === "members") result = { ok: true, project, members: describeMembers(project, store.members()) };
        else if (command === "send") {
          requireThat((v.text !== undefined) !== !!v.stdin, "E_USAGE", "Provide exactly one of --text or --stdin");
          const sender = actor(true), body = v.stdin ? await stdin(8192) : v.text!;
          const sent = await withRoomSelection(project, { runtime: sender.runtime, session: sender.session_ref }, async () =>
            store!.send({ from: actor(true).id, to: v.to, replyTo: v["reply-to"], body, notify: v.notify, id: v.id }));
          // Probe proof and notification are independent: one failing must not hide the other.
          let probeProof: unknown;
          if (sent.message.reply_to?.startsWith("probe-")) {
            // recordProbeReply silently ignores non-matching replies, so only a thrown failure is reported.
            try { recordProbeReply(store, project, sent.message, identify()); }
            catch (error) { probeProof = { state: "unrecorded", diagnostic: errorResult(error) }; }
          }
          let notification: unknown = { state: "not_requested" };
          try {
            if (sent.message.notify) notification = sent.reused ? { state: "not_retried", reason: "Idempotent resend never repeats a notification attempt" } : await notifyMember(store, project, store.member(sent.message.to_id!));
          } catch (error) { notification = { state: "unknown", diagnostic: errorResult(error) }; }
          result = { ok: true, stored: true, message_id: sent.message.id, seq: sent.message.seq, reused: sent.reused, notify_requested: !!sent.message.notify, notification,
            ...(probeProof ? { probe_proof: probeProof } : {}) };
        } else if (command === "read") {
          requireThat([v.new, v.after !== undefined, v.id !== undefined, v.mark !== undefined].filter(Boolean).length <= 1, "E_USAGE", "Choose one read mode");
          const me = actor(v.mark !== undefined);
          if (v.id) result = { ok: true, message: store.message(v.id) };
          else if (v.mark !== undefined) {
            const readSeq = await withRoomSelection(project, { runtime: me.runtime, session: me.session_ref }, async () => {
              actor(true); return store!.mark(me.id, number(v.mark, "mark")!);
            });
            result = { ok: true, read_seq: readSeq };
          }
          else result = { ok: true, ...store.read(number(v.after, "after") ?? me.read_seq, number(v.limit, "limit")) };
        } else if (command === "probe") result = await startProbe(store, project, v.to ? store.member(v.to) : actor());
        else if (command === "socket-config") {
          const member = v.to ? store.member(v.to) : actor();
          const configured = configureSocket(project, member, !!v.apply, !!v.disable);
          if (v.apply && !v.disable) {
            // An explicit repair already validated the exact live peer. It must also
            // clear SessionEnd's inactive flag for this existing room membership.
            saveState(project, { ...state(project, member), session: member.session_ref!, memberId: member.id, active: true, error: undefined });
            result = { ...configured, reception: receiver(project, member) };
          } else result = configured;
        }
        else if (command === "notify") {
          const me = v.to ? store.member(v.to) : actor();
          if (p[1] === "resume") { resume(project, me); result = { ok: true, resumed: me.id, old_reservations_preserved: true }; }
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
