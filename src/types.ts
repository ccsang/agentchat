export type Runtime = "codex" | "claude" | "generic";
export interface Identity { runtime: Runtime; session: string | null }
export interface Project { root: string; room: string; gitCommonDir: string | null; integration?: string; roomName?: string }
export interface Member {
  id: string; name: string; runtime: Runtime; session_ref: string | null;
  read_seq: number; created_at: number;
}
export interface Message {
  seq: number; id: string; from_id: string; to_id: string | null;
  reply_to: string | null; body: string; notify: number;
  notify_batch_id: string | null; notify_claimed_at: number | null; created_at: number;
}
export interface Page { after: number; next_cursor: number; has_more: boolean; messages: Message[] }
export interface Batch { id: string; member: Member; messages: Message[] }
export interface Policy {
  budget: number; windowSeconds: number; autoJoin: boolean; codexBin?: string;
}
export const DEFAULT_POLICY: Policy = { budget: 20, windowSeconds: 600, autoJoin: false };
export interface NotificationLimit {
  reason: "ready" | "budget_exhausted" | "minimum_interval";
  used: number; budget: number; window_ms: number; retry_at: number | null;
}
