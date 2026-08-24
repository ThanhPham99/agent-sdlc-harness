#!/usr/bin/env bash
set -euo pipefail

PLUGIN="agent-sdlc-harness"
MARKETPLACE="agent-sdlc-github"
REPO="${AGENT_SDLC_GITHUB_REPO:-}"
HOST="all"

usage() {
  cat <<'EOF'
Usage: ./install.sh --repo OWNER/REPO [--host claude|codex|antigravity|all]

You can also set AGENT_SDLC_GITHUB_REPO=OWNER/REPO.
When run from a git checkout, the script tries to infer OWNER/REPO from origin.
EOF
}

infer_repo() {
  command -v git >/dev/null 2>&1 || return 1
  local u
  u="$(git remote get-url origin 2>/dev/null || true)"
  [[ -n "$u" ]] || return 1
  u="${u%.git}"
  case "$u" in
    https://github.com/*) printf '%s\n' "${u#https://github.com/}" ;;
    git@github.com:*) printf '%s\n' "${u#git@github.com:}" ;;
    ssh://git@github.com/*) printf '%s\n' "${u#ssh://git@github.com/}" ;;
    *) return 1 ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then REPO="$(infer_repo || true)"; fi
if [[ -z "$REPO" || "$REPO" != */* || "$REPO" == http* ]]; then
  echo "A GitHub repository coordinate OWNER/REPO is required." >&2
  usage >&2
  exit 2
fi

install_claude() {
  command -v claude >/dev/null 2>&1 || { echo "[claude] CLI not found; skipped"; return 3; }
  echo "[claude] registering marketplace $REPO"
  if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    claude plugin marketplace update "$MARKETPLACE"
  else
    claude plugin marketplace add "$REPO"
  fi
  claude plugin install "$PLUGIN@$MARKETPLACE"
  echo "[claude] installed $PLUGIN@$MARKETPLACE"
}

install_codex() {
  command -v codex >/dev/null 2>&1 || { echo "[codex] CLI not found; skipped"; return 3; }
  echo "[codex] registering marketplace $REPO"
  if codex plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    :
  else
    if ! codex plugin marketplace add "$REPO"; then
      if ! codex plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
        echo "[codex] marketplace registration failed" >&2
        return 1
      fi
    fi
  fi
  # Codex plugin add is intentionally run unconditionally; it is the repair/reinstall path too.
  codex plugin add "$PLUGIN@$MARKETPLACE"
  echo "[codex] installed $PLUGIN@$MARKETPLACE"
}

install_antigravity() {
  command -v agy >/dev/null 2>&1 || { echo "[antigravity] agy CLI not found; skipped"; return 3; }
  agy plugin install "https://github.com/$REPO"
  echo "[antigravity] installed https://github.com/$REPO"
}

case "$HOST" in
  claude) install_claude ;;
  codex) install_codex ;;
  antigravity|agy) install_antigravity ;;
  all)
    found=0
    if command -v claude >/dev/null 2>&1; then install_claude; found=1; fi
    if command -v codex >/dev/null 2>&1; then install_codex; found=1; fi
    if command -v agy >/dev/null 2>&1; then install_antigravity; found=1; fi
    if [[ "$found" -eq 0 ]]; then
      echo "No supported host CLI found (claude, codex, agy)." >&2
      exit 3
    fi
    ;;
  *) echo "Unsupported host: $HOST" >&2; exit 2 ;;
esac
