#!/bin/sh
# Short lifecycle hook only. No download, project initialization or waiting loop.
set -u
case "${1:-}" in session-start|session-end) ;; *) exit 0 ;; esac
cli=""
if [ -n "${AGENTCHAT_BIN_DIR:-}" ] && [ -x "$AGENTCHAT_BIN_DIR/agentchat" ]; then
  cli="$AGENTCHAT_BIN_DIR/agentchat"
elif command -v agentchat >/dev/null 2>&1; then
  cli=$(command -v agentchat)
elif [ -x "$HOME/.local/bin/agentchat" ]; then
  cli="$HOME/.local/bin/agentchat"
fi
[ -n "$cli" ] || exit 0
# Forward stdin intact; the CLI resolves cwd from native hook JSON.
exec "$cli" hook "plugin-$1" 2>/dev/null
