import { join } from "node:path";
import { SOCKET_MIN_VERSION } from "./claude-peer.ts";
import { integrationDir } from "./project.ts";
import { roomName } from "./rooms.ts";
import { integrationSettings } from "./workspace.ts";
import type { Member, Project } from "./types.ts";

export interface LifecycleObservation { source: "plugin" | "project"; pid: number; at: number; root: string }
const failures: Record<string, { cause: string; reason: string; rebind?: boolean; stale?: boolean }> = {
  E_PEER_PROCESS: { cause: "stale_process", reason: "The saved native Claude process is no longer running.", rebind: true, stale: true },
  E_PEER_PROCESS_CHANGED: { cause: "process_changed", reason: "The saved native PID now belongs to a different process instance.", rebind: true, stale: true },
  E_PEER_INSTANCE_CHANGED: { cause: "socket_instance_changed", reason: "The native socket instance changed; the saved binding must be explicitly rebound.", rebind: true, stale: true },
  E_PEER_METADATA: { cause: "metadata_unavailable", reason: "The saved native peer metadata is missing, unreadable or malformed.", rebind: true, stale: true },
  E_PEER_SOCKET_MISSING: { cause: "socket_missing", reason: "The saved native socket or its directory is no longer available.", rebind: true, stale: true },
  E_PEER_CREDENTIAL: { cause: "credential_invalid", reason: "The native peer credential is missing, unreadable, invalid or belongs to another process." },
  E_PEER_CONNECT: { cause: "connection_failed", reason: "The native socket connection failed before submission; confirm that the exact Claude process is running.", rebind: true },
  E_PEER_AMBIGUOUS: { cause: "ambiguous_session", reason: "More than one live native process advertises this exact session; no process was selected." },
  E_PEER_NOT_FOUND: { cause: "peer_not_found", reason: "No verified live native peer matches this exact registered session.", rebind: true },
  E_PEER_REBIND: { cause: "authoritative_rebind_required", reason: "Changed native process requires its own SessionStart hook or explicit socket-config rebind.", rebind: true, stale: true },
  E_PEER_VERSION: { cause: "version_below_baseline_or_invalid", reason: `Claude Code ${SOCKET_MIN_VERSION} or newer is required; native version is missing, malformed or below the baseline.` },
  E_PEER_PROTOCOL: { cause: "protocol_incompatible", reason: "Incompatible native peerProtocol; this adapter implements peerProtocol 1." },
  E_PEER_KIND: { cause: "client_incompatible", reason: "Native socket reception requires an interactive Claude CLI session." },
  E_PERMISSIONS: { cause: "unsafe_permissions", reason: "Native peer ownership, permissions or file type are unsafe; inspect the host files without weakening their protection." },
  E_PROJECT: { cause: "project_mismatch", reason: "The bound native peer belongs to a different project." },
  E_IDENTITY: { cause: "session_mismatch", reason: "The bound native peer belongs to a different registered session." },
  E_RECEIVER: { cause: "session_ended", reason: "The native session ended; its own SessionStart or an explicit live-peer repair is required.", rebind: true },
  E_CONFIG: { cause: "workspace_disabled", reason: "The workspace integration is disabled or its configuration is invalid." },
  E_PAUSED: { cause: "notification_paused", reason: "Resolve the existing uncertain notification pause before enabling reception; old attempts will not be reset." },
  E_PLATFORM: { cause: "platform_unavailable", reason: "The native socket adapter is unavailable on this platform." },
  E_PEER: { cause: "binding_invalid", reason: "The saved native peer binding failed structural validation." },
  E_PEER_VALIDATE: { cause: "validation_failed", reason: "The exact native peer could not be validated; inspect its binding and host configuration." },
};
export function peerFailure(error: unknown, stage: "validation" | "connection") {
  // Never expose arbitrary exception messages: native JSON/parser/OS errors can contain credentials or paths.
  const value = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const code = stage === "connection" ? "E_PEER_CONNECT" : value === "ENOENT" || value === "ENOTDIR" ? "E_PEER_SOCKET_MISSING"
    : value === "EACCES" || value === "EPERM" || value === "ELOOP" ? "E_PERMISSIONS"
    : typeof value === "string" && Object.hasOwn(failures, value) ? value : "E_PEER_VALIDATE";
  return { code, ...failures[code]!, stage };
}
export function receptionCommand(project: Project, member: Member, command: "socket-config" | "probe"): string[] {
  return [join(integrationDir(project), "run"), "--project", project.root, "--room", roomName(project), command, "--to", member.id];
}
export function socketRecovery(project: Project, member: Member) {
  const argv = receptionCommand(project, member, "socket-config");
  return { preview_argv: argv, apply_argv: [...argv, "--apply"],
    hint: "Inspect the exact-member repair preview, then apply if repair is intended. It revalidates the live peer; it does not resend old reservations or prove model reception." };
}
export function lifecycleStatus(project: Project, observation?: LifecycleObservation, stale = false) {
  let configured: boolean | null = null;
  try { configured = integrationSettings(project).hooks; } catch { /* A diagnostic must not guess when configuration cannot be inspected. */ }
  const seen = observation?.root === project.root && ["plugin", "project"].includes(observation.source)
    && Number.isSafeInteger(observation.pid) && observation.pid > 1 && Number.isFinite(observation.at) ? observation : undefined;
  const warning = !stale ? undefined : seen
    ? "A previous AgentChat SessionStart was observed. Ensure lifecycle hooks run in the new native process, or use the exact-member repair preview/apply."
    : configured === true ? "Project lifecycle hooks are configured, but no AgentChat SessionStart was observed for this session. Load the hooks and use the native startup/resume flow."
    : configured === false ? "No AgentChat SessionStart was observed for this session and project hooks are not configured. Install/load the Claude AgentChat plugin's SessionStart/SessionEnd hooks, or explicitly preview/apply install --hooks. A missing observation does not prove the plugin is uninstalled."
    : "Project hook configuration could not be inspected. Check the Claude plugin's lifecycle hooks or project hook setup.";
  return { project_hooks_configured: configured, session_start_observed: !!seen, plugin_hook_observed: seen?.source === "plugin",
    last_start: seen ? { source: seen.source, pid: seen.pid, at: seen.at, root: project.root } : null, ...(warning ? { warning } : {}) };
}
