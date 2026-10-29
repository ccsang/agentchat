export class ChatError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function requireThat(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new ChatError(code, message);
}
export function errorResult(error: unknown) {
  if (error instanceof ChatError) return { ok: false, error: { code: error.code, message: error.message } };
  const value = error as { code?: string; message?: string };
  const code = value.code?.startsWith("ERR_PARSE_ARGS") ? "E_USAGE"
    : value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED" ? "E_BUSY" : "E_IO";
  return { ok: false, error: { code, message: value.message ?? "Operation failed" } };
}
