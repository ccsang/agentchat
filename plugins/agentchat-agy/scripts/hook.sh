#!/bin/sh
# Native agy hook stdin is authoritative; cwd is this plugin, not the workspace.
set -u
case "${1:-}" in session-start|pre-invocation) ;; *) printf '{}\n'; exit 0 ;; esac
cli=""
if [ -n "${AGENTCHAT_BIN_DIR:-}" ] && [ -x "$AGENTCHAT_BIN_DIR/agentchat" ]; then
  cli="$AGENTCHAT_BIN_DIR/agentchat"
elif command -v agentchat >/dev/null 2>&1; then
  cli=$(command -v agentchat)
elif [ -x "$HOME/.local/bin/agentchat" ]; then
  cli="$HOME/.local/bin/agentchat"
fi
if [ -z "$cli" ]; then printf '{}\n'; exit 0; fi
exec "$cli" hook "agy-$1"
