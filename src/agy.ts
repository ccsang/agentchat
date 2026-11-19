import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { discoverProject, integrationDir } from "./project.ts";
import { sessionId } from "./identity.ts";
import { nearestHost } from "./host-context.ts";
import { processAncestors } from "./lifecycle.ts";
import type { Ancestor } from "./lifecycle.ts";
import { readJson, writeJson, privateDirectory } from "./files.ts";
import { requireThat } from "./errors.ts";
import { installation } from "./workspace.ts";
import { memberLeft, memberRoomSelected, resolveRoom, roomExists, selectedRoom, tryRoomSelectionLock } from "./rooms.ts";
import { Store } from "./store.ts";
import { pause, paused, policy, saveState, state, uninstalled } from "./runtime.ts";
import { tryLock } from "./lock.ts";
import { notice } from "./notify.ts";
import type { Member, Project } from "./types.ts";

export const AGY_TURN = "agy-turn-based";
export interface AgyObservation {
  schema: 1; runtime: "agy"; session: string; pid: number; procStart: string; instance: string;
  root: string; observedAt: number; source: "native_tool" | "SessionStart" | "PreInvocation";
}
export interface AgyHookInput { conversationId: string; workspacePaths: string[] }
export function agyObservation(project: Project, session: string): AgyObservation | null {
  const value = readJson<AgyObservation>(join(integrationDir(project), "native-sessions", `agy-${sessionId(session)}.json`));
  requireThat(!value || value.schema === 1 && value.runtime === "agy" && value.session === session
    && Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.procStart === "string" && typeof value.instance === "string" && isAbsolute(value.root),
  "E_CONFIG", "Invalid agy native observation");
  return value;
}
export function agyMode(_project: Project, _session: string): typeof AGY_TURN { return AGY_TURN; }
export function observeAgyLocked(project: Project, session: string, source: AgyObservation["source"], ancestors = processAncestors()): AgyObservation {
  const host = nearestHost(ancestors);
  requireThat(host?.runtime === "agy", "E_IDENTITY", "agy requires the nearest native agy process");
  const owner = host.process;
  const previous = agyObservation(project, session);
  const same = previous?.pid === owner.pid && previous.procStart === owner.procStart;
  const next: AgyObservation = { schema: 1, runtime: "agy", session: sessionId(session), pid: owner.pid, procStart: owner.procStart,
    instance: same ? previous.instance : randomUUID(), root: project.root, observedAt: Date.now(), source };
  writeJson(join(integrationDir(project), "native-sessions", `agy-${session}.json`), next);
  return next;
}
export function agyReceiver(project: Project, member: Member): Record<string, unknown> {
  const mode = agyMode(project, member.session_ref!), observation = agyObservation(project, member.session_ref!), stopped = paused(project, member);
  const saved = state(project, member), proof = saved?.proof;
  const verified = !!observation && proof?.adapter === mode && proof.receiverToken === observation.instance;
  return { mode, state: stopped ? "paused" : observation ? "awaiting_invocation" : "hook_unobserved",
    delivery: "turn_based", transport_alive: null,
    idle_wake: "deferred", compact: "untested",
    verification: verified ? "last_observed_instance_nonce" : "unverified", evidence: null, historical_evidence: verified ? proof : null,
    reason: stopped?.reason ?? "Messages are injected on the next native PreInvocation; this does not wake an idle CLI. Hook output/reservation is not model-consumption proof. Idle wake is deferred.",
    last_injection_unconfirmed: saved?.injection ?? null,
    hook_observed: !!observation && observation.source !== "native_tool", last_observed: observation ? { at: observation.observedAt, source: observation.source } : null, manual_read_available: true };
}
export async function agyHook(input: AgyHookInput, event: "SessionStart" | "PreInvocation", ancestors?: Ancestor[], options: { clock?: () => number; budgetMs?: number } = {}): Promise<Record<string, unknown>> {
  const clock = options.clock ?? (() => performance.now()), deadline = clock() + (options.budgetMs ?? 2500);
  const session = sessionId(input?.conversationId);
  requireThat(Array.isArray(input.workspacePaths) && input.workspacePaths.length >= 1 && input.workspacePaths.length <= 16
    && input.workspacePaths.every(p => typeof p === "string" && isAbsolute(p)), "E_PROJECT", "agy hook requires absolute native workspacePaths");
  const projects = new Map<string, Project>();
  for (const path of input.workspacePaths) {
    try { const project = discoverProject(path); projects.set(project.root, project); }
    catch (error) { if ((error as { code?: string }).code !== "E_NOT_PROJECT") throw error; }
  }
  if (!projects.size) return {};
  requireThat(projects.size === 1, "E_PROJECT", "Multiple agy workspaces are ambiguous; no project was selected or notified");
  const base = [...projects.values()][0]!, saved = installation(base);
  if (!saved?.installed || saved.root !== base.root || uninstalled(base)) return {};
  if (clock() >= deadline) return {};
  const selectionRelease = tryRoomSelectionLock(base, { runtime: "agy", session });
  if (!selectionRelease) return {};
  try {
    const selection = selectedRoom(base, { runtime: "agy", session });
    if (selection === null) return {};
    const project = resolveRoom(base, selection);
    if (!roomExists(project)) return {};
    const store = new Store(project.room, { readonly: event !== "PreInvocation" });
    try {
      let member: Member;
      try { member = store.actor({ runtime: "agy", session }); }
      catch (error) { if ((error as { code?: string }).code === "E_NOT_JOINED") return {}; throw error; }
      if (memberLeft(project, member) || !memberRoomSelected(project, member)) return {};
      if (clock() >= deadline) return {};
      const observation = observeAgyLocked(project, session, event, ancestors ?? processAncestors(1000));
      // Never enroll unknown hook UUIDs or treat Stop as process exit.
      if (event !== "PreInvocation" || paused(project, member) || clock() + 100 >= deadline) return {};
      privateDirectory(join(project.room, "notifications"));
      const release = tryLock(join(project.room, "notifications", `${member.id}.lock`));
      if (!release) return {};
      try {
        const config = policy(project), now = Date.now();
        if (clock() + 100 >= deadline) return {};
        const claim = store.claim(member.id, config.budget, now, config.windowSeconds * 1000);
        if (!claim.batch) return {};
        try {
          // active is a legacy required field, never an agy reception gate or
          // presence signal. agy reads only proof/injection from this state.
          saveState(project, { ...state(project, member), session, memberId: member.id, runtime: "agy", active: false,
            injection: { adapter: AGY_TURN, batchId: claim.batch.id, instance: observation.instance, reservedAt: now, messageIds: claim.batch.messages.map(m => m.id) } });
        } catch (error) {
          // Keep the immutable reservation and prevent future attempts when a
          // receipt cannot be recorded; do not turn a lost stdout into replay.
          pause(project, member, "agy_injection_outcome_unknown", { adapter: AGY_TURN }); throw error;
        }
        // The reservation remains consumed even if stdout is lost or the host
        // ignores the response. A different adapter must not replay it.
        return { injectSteps: [{ systemMessage: { systemMessage: notice(claim.batch, project) } }] };
      } finally { release(); }
    } finally { store.close(); }
  } finally { selectionRelease(); }
}
