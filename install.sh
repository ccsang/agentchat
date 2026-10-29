#!/bin/sh
set -eu
umask 077

AGENTCHAT_VERSION="v0.1.0-alpha.7"
release="https://github.com/ccsang/agentchat/releases/download/$AGENTCHAT_VERSION"
project=""
apply=0
stage=""
fail() { printf 'AgentChat: %s\n' "$*" >&2; exit 1; }
cleanup() { if [ -n "$stage" ]; then rm -rf "$stage"; fi; }
trap cleanup 0
trap 'exit 1' 1 2 15

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--project needs a directory'; project="$2"; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h)
      printf '%s\n' "AgentChat $AGENTCHAT_VERSION installer" \
        'Usage: sh install.sh' \
        'Downloads and verifies the standalone CLI; no Bun or Node.js installation is needed.' \
        'Installs the program once; join prepares local state without changing instructions or hooks.' \
        'AGENTCHAT_INSTALL_DIR overrides the cache; AGENTCHAT_BIN_DIR overrides the command directory.' \
        'Legacy explicit project preview/repair: --project DIR [--apply].'
      exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

if [ -n "$project" ]; then
  [ -d "$project" ] || fail "Project directory does not exist: $project"
  project=$(cd "$project" && pwd -P)
elif [ "$apply" -eq 1 ]; then
  fail '--apply requires --project for legacy project repair; ordinary installation needs neither'
fi
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'This Alpha supports macOS and Linux only' ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Unsupported CPU architecture' ;; esac
for tool in curl gzip awk mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "Required tool is missing: $tool"; done
if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail 'SHA-256 verification needs sha256sum or shasum'
fi

install_dir=${AGENTCHAT_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agentchat}
case "$install_dir" in /*) ;; *) fail 'AGENTCHAT_INSTALL_DIR must be absolute' ;; esac
[ "$install_dir" != / ] && [ ! -L "$install_dir" ] || fail 'Invalid executable cache directory'
mkdir -p "$install_dir"
install_dir=$(cd "$install_dir" && pwd -P)
stage=$(mktemp -d "$install_dir/.download.XXXXXXXX")
download() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 300 "$release/$1" --output "$2" || fail "Download failed: $1"
}
download SHA256SUMS "$stage/SHA256SUMS"
checksum() {
  awk -v name="$1" '$2 == name { count++; value=$1 } END { if (count != 1 || length(value) != 64 || value !~ /^[0-9a-f]+$/) exit 1; print value }' "$stage/SHA256SUMS"
}
name="agentchat-$AGENTCHAT_VERSION-$platform-$arch"
expected=$(checksum "$name") || fail 'Invalid executable checksum entry'
expected_gzip=$(checksum "$name.gz") || fail 'Invalid download checksum entry'
version_dir="$install_dir/$AGENTCHAT_VERSION/$platform-$arch"
binary="$version_dir/agentchat"
[ ! -L "$binary" ] || fail 'Refusing a symlink in the executable cache'
if [ ! -f "$binary" ] || [ "$(digest "$binary")" != "$expected" ]; then
  printf 'AgentChat: downloading %s for %s/%s\n' "$AGENTCHAT_VERSION" "$platform" "$arch" >&2
  download "$name.gz" "$stage/agentchat.gz"
  [ "$(digest "$stage/agentchat.gz")" = "$expected_gzip" ] || fail 'Download checksum mismatch; nothing was executed'
  gzip -dc "$stage/agentchat.gz" > "$stage/agentchat" || fail 'Cannot decompress the executable'
  [ "$(digest "$stage/agentchat")" = "$expected" ] || fail 'Executable checksum mismatch; nothing was executed'
  chmod 700 "$stage/agentchat"
  mkdir -p "$version_dir"
  mv "$stage/agentchat" "$binary"
fi
actual=$("$binary" --version) || fail 'The executable cannot run on this system; Linux requires glibc'
[ "$actual" = "${AGENTCHAT_VERSION#v}" ] || fail 'Unexpected executable version'
cleanup
stage=""
trap - 0 1 2 15
if [ -z "$project" ]; then
  exec "$binary" setup
fi
"$binary" setup > /dev/null
if [ "$apply" -eq 1 ]; then
  exec "$binary" --project "$project" install --apply
else
  exec "$binary" --project "$project" install
fi
