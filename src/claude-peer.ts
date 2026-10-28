import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { ChatError, requireThat } from "./errors.ts";
import { regularFile } from "./files.ts";
import { discoverProject } from "./project.ts";
import type { Member, Project } from "./types.ts";

export const SOCKET_ADAPTER = "claude-socket-experimental";
export const SOCKET_VERSIONS = ["2.1.312"];
interface PeerRecord {
  pid: number; sessionId: string; cwd: string; procStart: string; version: string;
  peerProtocol: number; kind: string; entrypoint: string; messagingSocketPath: string;
  status?: string; statusUpdatedAt?: number;
}
export interface PeerBinding {
  enabled: boolean; pid: number; session: string; procStart: string; version: string;
  cwd?: string;
  metadataPath: string; socketPath: string; realSocketPath: string; socketDev: number; socketIno: number;
  instance: string; configuredAt: number;
}
export function canonicalSocketPath(path: string): string {
  const info = lstatSync(path);
  requireThat(info.isSocket() && !info.isSymbolicLink(), "E_PEER", "Native peer path is not a real socket");
  // Bun 1.3.14 realpathSync cannot resolve a socket inode; resolve its real parent.
  return join(realpathSync(dirname(path)), basename(path));
}
export function processStart(pid: number): string {
  requireThat(Number.isSafeInteger(pid) && pid > 1, "E_PEER", "Invalid native process ID");
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, encoding: "utf8", timeout: 1500, killSignal: "SIGKILL",
  });
  requireThat(result.status === 0 && result.stdout.trim(), "E_PEER", "The exact native Claude process is no longer available");
  return result.stdout.trim().replace(/\s+/g, " ");
}
function ownedDirectory(path: string, privateOnly: boolean): void {
  const info = lstatSync(path);
  requireThat(info.isDirectory() && !info.isSymbolicLink() && (!process.getuid || info.uid === process.getuid()), "E_PERMISSIONS", "Peer directory is not an owned real directory");
  requireThat((info.mode & 0o022) === 0, "E_PERMISSIONS", "Peer directory must not be writable by another user");
  requireThat(!privateOnly || (info.mode & 0o077) === 0, "E_PERMISSIONS", "Peer socket directory must be owner-only");
}
function record(path: string): PeerRecord {
  ownedDirectory(dirname(path), false); regularFile(path, false);
  requireThat((lstatSync(path).mode & 0o022) === 0, "E_PERMISSIONS", "Peer metadata must not be writable by another user");
  requireThat(lstatSync(path).size <= 65536, "E_PEER", "Peer metadata is too large");
  const value = JSON.parse(readFileSync(path, "utf8")) as PeerRecord;
  requireThat(Number.isSafeInteger(value.pid) && value.pid > 1 && basename(path) === `${value.pid}.json`, "E_PEER", "Peer metadata PID mismatch");
  return value;
}
function inspect(project: Project, member: Member, path: string, expected?: PeerBinding): PeerBinding {
  requireThat(process.platform === "darwin" || process.platform === "linux", "E_PLATFORM", "Experimental native sockets support macOS/Linux only");
  const value = record(path);
  requireThat(member.runtime === "claude" && value.sessionId === member.session_ref, "E_IDENTITY", "Peer metadata belongs to a different native Claude session");
  requireThat(value.peerProtocol === 1 && SOCKET_VERSIONS.includes(value.version) && value.kind === "interactive" && value.entrypoint === "cli", "E_PEER_VERSION", "Unverified Claude socket protocol/version or client kind; experimental adapter refuses this combination");
  requireThat(typeof value.cwd === "string" && (expected?.cwd === value.cwd || discoverProject(value.cwd).room === project.room), "E_PROJECT", "Native Claude peer belongs to another project room");
  requireThat(typeof value.procStart === "string" && value.procStart.trim().replace(/\s+/g, " ") === processStart(value.pid), "E_PEER", "Native PID was reused or its process-start evidence changed");
  const socketPath = value.messagingSocketPath;
  requireThat(typeof socketPath === "string" && isAbsolute(socketPath) && basename(socketPath) === `${value.pid}.sock`, "E_PEER", "Native socket path does not match the exact peer PID");
  ownedDirectory(dirname(socketPath), true);
  const socket = lstatSync(socketPath);
  requireThat(socket.isSocket() && !socket.isSymbolicLink() && (!process.getuid || socket.uid === process.getuid()) && (socket.mode & 0o077) === 0, "E_PERMISSIONS", "Native socket must be an owned private socket");
  const binding = { enabled: true, pid: value.pid, session: value.sessionId, procStart: value.procStart, version: value.version, cwd: value.cwd,
    metadataPath: path, socketPath, realSocketPath: canonicalSocketPath(socketPath), socketDev: socket.dev, socketIno: socket.ino,
    instance: "", configuredAt: expected?.configuredAt ?? Date.now() };
  binding.instance = createHash("sha256").update(JSON.stringify([binding.pid, binding.session, binding.procStart, binding.version,
    binding.realSocketPath, binding.socketDev, binding.socketIno])).digest("hex");
  requireThat(!expected || (expected.instance === binding.instance && expected.socketPath === socketPath), "E_PEER", "Native socket instance changed; explicitly rebind and verify before sending");
  peerToken(binding);
  return binding;
}
export function peerToken(binding: PeerBinding): string {
  // 2.1.312 hashes the published path, not macOS's /private/tmp canonical alias.
  const hash = createHash("sha256").update(binding.socketPath).digest("hex");
  const path = join(dirname(binding.metadataPath), `${binding.pid}.${hash}.key`);
  regularFile(path);
  requireThat(lstatSync(path).size <= 4096, "E_PEER", "Native peer key record is too large");
  const value = JSON.parse(readFileSync(path, "utf8")) as { peerToken?: string; procStart?: string };
  requireThat(typeof value.peerToken === "string" && /^[0-9a-f]{32}$/.test(value.peerToken) && value.procStart === binding.procStart,
    "E_PEER", "Native peer token is missing or belongs to another process instance");
  return value.peerToken;
}
export function validatePeer(project: Project, member: Member, binding: PeerBinding): PeerBinding {
  return inspect(project, member, binding.metadataPath, binding);
}
export function peerActivity(binding: PeerBinding): { status?: string; updatedAt?: number } {
  const value = record(binding.metadataPath);
  requireThat(value.pid === binding.pid && value.sessionId === binding.session && value.procStart === binding.procStart, "E_PEER", "Native peer changed during observation");
  return { status: value.status, updatedAt: value.statusUpdatedAt };
}
export function discoverPeer(project: Project, member: Member, env: NodeJS.ProcessEnv = process.env): PeerBinding {
  requireThat(member.runtime === "claude" && member.session_ref, "E_IDENTITY", "Select one exact registered Claude session");
  const directory = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
  requireThat(existsSync(directory), "E_PEER", "Native Claude peer metadata is unavailable");
  ownedDirectory(directory, false);
  const names = readdirSync(directory).filter(name => /^\d+\.json$/.test(name));
  requireThat(names.length <= 1000, "E_PEER", "Peer metadata directory is too large for bounded discovery");
  const matches: PeerBinding[] = [];
  let liveMatches = 0;
  let diagnostic: unknown;
  for (const name of names) {
    const path = join(directory, name);
    let value: PeerRecord;
    try { value = record(path); } catch { continue; }
    if (value.sessionId !== member.session_ref) continue;
    try {
      if (typeof value.procStart === "string" && value.procStart.trim().replace(/\s+/g, " ") === processStart(value.pid) &&
          typeof value.cwd === "string" && discoverProject(value.cwd).room === project.room) liveMatches++;
    } catch { /* A stale advertisement is never selected as a replacement. */ }
    try { matches.push(inspect(project, member, path)); } catch (error) { diagnostic = error; }
  }
  requireThat(liveMatches <= 1 && matches.length <= 1, "E_PEER", "More than one live process advertises this exact native session; refuse ambiguous routing");
  if (!matches.length && diagnostic instanceof Error) throw diagnostic;
  requireThat(matches.length === 1, "E_PEER", "No verified live peer matches this exact registered session; no recent-session guessing");
  return matches[0]!;
}
export function peerFrame(content: string, messageId: string): string {
  requireThat(/^cc-msg-[0-9a-f]{32}$/.test(messageId) && Buffer.byteLength(content) <= 32768, "E_SIZE", "Invalid native notification envelope");
  // No child credentials, reply socket, sender permission-class claim, or forged Claude identity.
  return JSON.stringify({ type: "user", message: { role: "user", content }, priority: "next", msgV: 1, msg_id: messageId }) + "\n";
}
export async function connectPeer(binding: PeerBinding, timeoutMs = 2000) {
  const socket = createConnection({ path: binding.socketPath });
  let failure: Error | undefined;
  socket.on("error", error => { failure = error; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new ChatError("E_PEER_CONNECT", "Native peer connection timed out before submission")); }, timeoutMs);
      const error = () => { clearTimeout(timer); reject(new ChatError("E_PEER_CONNECT", "Native peer refused the connection before submission")); };
      socket.once("error", error);
      socket.once("connect", () => { clearTimeout(timer); socket.off("error", error); resolve(); });
    });
  } catch (error) { socket.destroy(); throw error; }
  return {
    async send(content: string, messageId: string): Promise<void> {
      const token = peerToken(binding), frame = peerFrame(content, messageId);
      if (failure || socket.destroyed) throw new ChatError("E_PEER_WRITE", "Native socket closed; submission outcome is unknown");
      await new Promise<void>((resolve, reject) => {
        const error = () => { clearTimeout(timer); socket.off("error", error); reject(new ChatError("E_PEER_WRITE", "Native socket write outcome is unknown")); };
        const timer = setTimeout(() => { socket.destroy(); error(); }, timeoutMs);
        socket.once("error", error);
        socket.write(JSON.stringify({ type: "auth", token }) + "\n" + frame, err => {
          clearTimeout(timer); socket.off("error", error);
          if (err || failure) reject(new ChatError("E_PEER_WRITE", "Native socket write outcome is unknown")); else resolve();
        });
      });
    },
    close() { socket.destroy(); },
  };
}
