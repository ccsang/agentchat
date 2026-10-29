import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { connectPeer, SOCKET_ADAPTER, validatePeer } from "./claude-peer.ts";
import { socketBinding } from "./socket-state.ts";
import { pause, paused, policy, uninstalled } from "./runtime.ts";
import { tryLock } from "./lock.ts";
import { privateDirectory } from "./files.ts";
import { notice } from "./notify.ts";
import type { Member, Project } from "./types.ts";
import type { Store } from "./store.ts";
import { memberRoomSelected } from "./rooms.ts";

export async function dispatchSocket(store: Store, project: Project, member: Member): Promise<Record<string, unknown>> {
  if (!memberRoomSelected(project, member)) return { state: "held", reason: "room_not_selected", automatic_retry: false };
  privateDirectory(join(project.room, "notifications"));
  const release = tryLock(join(project.room, "notifications", `${member.id}.lock`));
  if (!release) return { state: "held", reason: "adapter_busy" };
  let connection: Awaited<ReturnType<typeof connectPeer>> | undefined;
  try {
    if (uninstalled(project)) return { state: "unavailable", reason: "Project integration was uninstalled" };
    const stopped = paused(project, member, SOCKET_ADAPTER);
    if (stopped) return { state: "paused", reason: stopped.reason };
    const binding = socketBinding(project, member);
    if (!binding?.enabled) return { state: "unavailable", reason: "Native socket experiment has not been explicitly enabled" };
    try { validatePeer(project, member, binding); connection = await connectPeer(binding); validatePeer(project, member, binding); }
    catch { return { state: "unavailable", reason: "Exact native peer failed validation or connection; no notification reservation was consumed" }; }
    const config = policy(project), claim = store.claim(member.id, config.budget, Date.now(), config.windowSeconds * 1000);
    if (!claim.batch) return { state: "held", reason: claim.reason, used: claim.used, retry_at: claim.retry_at, automatic_retry: false };
    const wireId = `cc-msg-${randomUUID().replaceAll("-", "")}`;
    try { await connection.send(notice(claim.batch, project), wireId); validatePeer(project, member, binding); }
    catch {
      pause(project, member, "socket_outcome_unknown", { adapter: SOCKET_ADAPTER });
      return { state: "unknown", batch_id: claim.batch.id, wire_id: wireId, reason: "Native peer may have received the frame; no retry or fallback" };
    }
    return { state: "submitted", batch_id: claim.batch.id, wire_id: wireId, adapter: SOCKET_ADAPTER, host_version: binding.version,
      receiver_instance: binding.instance, processed: false, note: "Socket write is unconfirmed; native hold/refuse policy may apply. Require an exact-session nonce reply." };
  } finally { connection?.close(); release(); }
}
