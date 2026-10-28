import { version } from "../package.json";

const plannedCommands = new Set(["join", "members", "send", "read"]);

const help = `AgentChat ${version}

Lightweight local communication for coding agents.
Status: project scaffold; joining, messaging, and notifications are not implemented.

Usage:
  agentchat --help
  agentchat --version

Planned agent-facing commands:
  join       Discover the project and register the current native session.
  members    List registered room members.
  send       Append a shared message, directed request, or reply.
  read       Read messages; move the read cursor only when explicitly requested.

Read ONBOARDING.md for the intended agent-driven setup flow.
Read docs/implementation-plan.md before implementing native integrations.
`;

export function runCli(args: readonly string[]): number {
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h", "help"].includes(args[0]!))
  ) {
    console.log(help);
    return 0;
  }

  if (args.length === 1 && ["--version", "-v", "version"].includes(args[0]!)) {
    console.log(version);
    return 0;
  }

  const command = args[0]!;
  const planned = plannedCommands.has(command);
  console.error(
    JSON.stringify({
      ok: false,
      error: {
        code: planned ? "E_NOT_IMPLEMENTED" : "E_USAGE",
        message: planned
          ? `${command} is planned but not implemented. No session was joined or notified.`
          : "Unsupported arguments. Run agentchat --help.",
      },
    }),
  );
  return 2;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
