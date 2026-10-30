import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWrite, pathPresent, privateDirectory, regularFile } from "./files.ts";
import { requireThat } from "./errors.ts";
import { tryLock } from "./lock.ts";

export const INBOUND_CHOICES = ["accept", "hold", "refuse", "default"] as const;
export type InboundChoice = typeof INBOUND_CHOICES[number];
interface InboundPlan { directory: string; path: string; before: string | null; after: string; mode: number; choice: InboundChoice }
const note = "User settings only: this affects all inbound peer messages, not just AgentChat. Managed settings, --settings and stricter project/local rules may override it. Effective native policy and model reception are not verified.";

function directory(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  requireThat(isAbsolute(path), "E_CONFIG", "CLAUDE_CONFIG_DIR must be absolute");
  return resolve(path);
}
function checkDirectory(path: string): void {
  if (!pathPresent(path)) return;
  const info = lstatSync(path);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid()) && (info.mode & 0o022) === 0,
    "E_PERMISSIONS", "Claude configuration directory must be owned, real and not writable by another user");
}
function current(path: string): string | null {
  if (!pathPresent(path)) return null;
  regularFile(path, false);
  const info = lstatSync(path);
  requireThat((info.mode & 0o022) === 0 && info.size <= 1024 * 1024, "E_CONFIG", "Claude settings must not be writable by another user or exceed 1 MiB");
  return readFileSync(path, "utf8");
}
function settings(text: string | null): Record<string, unknown> {
  let value: unknown;
  try { value = text === null ? {} : JSON.parse(text); }
  catch { requireThat(false, "E_CONFIG", "Claude settings are not valid JSON; repair them before changing inbound policy"); }
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "E_CONFIG", "Claude settings must be a JSON object");
  return value as Record<string, unknown>;
}
function policy(text: string | null): unknown {
  const value = settings(text).crossSessionInbound;
  return value === undefined ? null : ["accept", "hold", "refuse"].includes(value as string) ? value : "unrecognized";
}
function hash(text: string | null) { return text === null ? null : createHash("sha256").update(text).digest("hex"); }

export function claudeInboundStatus(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const dir = directory(env); checkDirectory(dir);
  const path = join(dir, "settings.json");
  return { ok: true, scope: "user", path, configured: policy(current(path)), effective_policy_verified: false, reception_verified: false, note,
    next: "For unattended reception, preview claude-inbound accept; apply only within the user's explicit request. Otherwise use /config > Messages from your other sessions." };
}
export function planClaudeInbound(choice: InboundChoice): InboundPlan {
  requireThat(INBOUND_CHOICES.includes(choice), "E_USAGE", "Use claude-inbound [accept|hold|refuse|default] [--apply]");
  const dir = directory(); checkDirectory(dir);
  const path = join(dir, "settings.json"), before = current(path), value = settings(before);
  if (choice === "default") delete value.crossSessionInbound; else value.crossSessionInbound = choice;
  const unchanged = choice === "default" ? settings(before).crossSessionInbound === undefined : settings(before).crossSessionInbound === choice;
  return { directory: dir, path, before, after: unchanged ? before ?? "{}\n" : JSON.stringify(value, null, 2) + "\n",
    mode: before === null ? 0o600 : lstatSync(path).mode & 0o777, choice };
}
export function previewClaudeInbound(plan: InboundPlan): Record<string, unknown> {
  const changed = plan.before === null ? plan.choice !== "default" : plan.before !== plan.after;
  return { ok: true, applied: false, scope: "user", path: plan.path, configured: policy(plan.before), requested: plan.choice,
    changed, before_sha256: hash(plan.before), after_sha256: changed ? hash(plan.after) : hash(plan.before),
    effective_policy_verified: false, reception_verified: false, note };
}
export function applyClaudeInbound(plan: InboundPlan): Record<string, unknown> {
  checkDirectory(plan.directory);
  requireThat(current(plan.path) === plan.before, "E_CONFLICT", "Claude settings changed since preview; generate a new plan");
  if (!previewClaudeInbound(plan).changed) return { ...previewClaudeInbound(plan), applied: true, backup: null };
  mkdirSync(plan.directory, { recursive: true, mode: 0o700 }); checkDirectory(plan.directory);
  const release = tryLock(join(plan.directory, ".agentchat-inbound.lock"));
  requireThat(release, "E_BUSY", "Another AgentChat inbound configuration update is running");
  try {
    requireThat(current(plan.path) === plan.before, "E_CONFLICT", "Claude settings changed since preview; generate a new plan");
    let backup: string | null = null;
    if (plan.before !== null) {
      const backups = join(plan.directory, ".agentchat-backups"); privateDirectory(backups);
      backup = join(backups, `settings-${randomUUID()}.json`); atomicWrite(backup, plan.before);
    }
    requireThat(current(plan.path) === plan.before, "E_CONFLICT", "Claude settings changed while backing up; generate a new plan");
    atomicWrite(plan.path, plan.after, plan.mode);
    return { ...previewClaudeInbound(plan), applied: true, backup, configured: policy(plan.after),
      next: "Check Claude's effective inbound setting. A fresh exact-session nonce reply is still required to verify automatic reception; do not replay old notifications." };
  } finally { release(); }
}
