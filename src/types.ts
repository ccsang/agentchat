export type Runtime = "codex" | "claude" | "generic";
export interface Identity { runtime: Runtime; session: string | null }
export interface Project { root: string; room: string; gitCommonDir: string | null }
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
  budget: number; watchSeconds: number; autoJoin: boolean; codexBin?: string;
}
export const DEFAULT_POLICY: Policy = { budget: 20, watchSeconds: 300, autoJoin: false };
