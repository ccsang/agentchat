import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { fixture, nativeIdentity, testEnv } from "./helpers.ts";

test("one-way Channel waits for initialization and emits IDs without tools or permission relay", async () => {
  const f = fixture(); const store = new Store(f.project.room, { create: true });
  const a = store.join(nativeIdentity()), b = store.join(nativeIdentity("claude"));
  store.send({ from: a.id, to: b.id, notify: true, id: "mcp-message", body: "UNTRUSTED BODY MUST STAY IN SQLITE" });
  const env = Object.fromEntries(Object.entries(testEnv({ AGENTCHAT_CLAUDE_SESSION_ID: b.session_ref! })).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dir, "../bin/agentchat"), "--project", f.root, "notify", "claude-channel"], env, stderr: "pipe" });
  const client = new Client({ name: "agentchat-test", version: "1" });
  let resolveEvent!: (value: Record<string, unknown>) => void;
  const event = new Promise<Record<string, unknown>>(resolve => { resolveEvent = resolve; });
  client.fallbackNotificationHandler = async notification => {
    if (notification.method === "notifications/claude/channel") resolveEvent(notification.params ?? {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect(transport);
    const params = await Promise.race([event, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Channel notification timeout")), 5000); })]);
    expect(params.content).toContain("mcp-message"); expect(params.content).not.toContain("UNTRUSTED BODY");
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeUndefined();
    expect(capabilities?.experimental?.["claude/channel"]).toEqual({});
    expect(capabilities?.experimental?.["claude/channel/permission"]).toBeUndefined();
    expect(store.member(b.id).read_seq).toBe(0);
    expect(store.claim(b.id, 20, Date.now() + 6000).batch).toBeNull();
  } finally {
    if (timer) clearTimeout(timer);
    await client.close(); store.close(); f.cleanup();
  }
}, 10000);
