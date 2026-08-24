#!/usr/bin/env bash
set -euo pipefail

PLUGIN="agent-sdlc-harness"
MARKETPLACE="agent-sdlc-github"
REPO="${AGENT_SDLC_GITHUB_REPO:-ThanhPham99/agent-sdlc-harness}"
HOST="all"
AUTO_ACTIVATE="default"
DRY_RUN=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: ./install.sh [--repo OWNER/REPO] [--host claude|codex|antigravity|all]
                    [--auto-activate | --no-auto-activate] [--dry-run]

Auto-activation:
  Claude Code and Antigravity receive the compact bootstrap from the plugin's own
  hooks; nothing outside the plugin is modified.
  Codex has no stable plugin hook contract, so strong activation additionally needs a
  managed block in $CODEX_HOME/AGENTS.md. --auto-activate installs it (idempotent and
  reversible, existing content preserved); --no-auto-activate leaves Codex in soft
  skill-discovery mode. Default: install the managed Codex block.

You can also set AGENT_SDLC_GITHUB_REPO=OWNER/REPO.
When run from a git checkout, the script tries to infer repository from origin.
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
    --auto-activate) AUTO_ACTIVATE="yes"; shift ;;
    --no-auto-activate) AUTO_ACTIVATE="no"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" ]]; then REPO="$(infer_repo || true)"; fi
if [[ -z "$REPO" || "$REPO" != */* || "$REPO" == http* ]]; then
  echo "A GitHub repository coordinate (e.g. ThanhPham99/agent-sdlc-harness) is required." >&2
  usage >&2
  exit 2
fi

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then echo "[dry-run] $*"; else "$@"; fi
}

codex_bootstrap() {
  # Managed global instruction block for Codex; it is the only file this installer writes.
  [[ "$AUTO_ACTIVATE" == "no" ]] && { echo "[codex] auto-activation bootstrap skipped (soft skill discovery only)"; return 0; }
  command -v node >/dev/null 2>&1 || { echo "[codex] node not found; managed bootstrap skipped (soft activation only)" >&2; return 0; }
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$major" -lt 18 ]]; then
    echo "[codex] node $major is below the required engine floor (>=18); managed bootstrap skipped (soft activation only)" >&2
    return 0
  fi
  local script="$HERE/scripts/codex-bootstrap.mjs"
  [[ -f "$script" ]] || { echo "[codex] $script not found; managed bootstrap skipped" >&2; return 0; }
  # A bootstrap failure must not fail an otherwise successful plugin install; it only
  # downgrades Codex to soft activation, which is reported here and by `activation doctor`.
  if [[ "$DRY_RUN" -eq 1 ]]; then
    node "$script" install --dry-run || echo "[codex] managed bootstrap dry-run failed; soft activation only" >&2
  else
    node "$script" install || echo "[codex] managed bootstrap failed; soft activation only" >&2
  fi
}

install_claude() {
  command -v claude >/dev/null 2>&1 || { echo "[claude] CLI not found; skipped"; return 3; }
  echo "[claude] registering marketplace $REPO"
  if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    run claude plugin marketplace update "$MARKETPLACE"
  else
    run claude plugin marketplace add "$REPO"
  fi
  run claude plugin install "$PLUGIN@$MARKETPLACE"
  echo "[claude] installed $PLUGIN@$MARKETPLACE (auto-activation delivered by the plugin SessionStart hook)"
}

install_codex() {
  command -v codex >/dev/null 2>&1 || { echo "[codex] CLI not found; skipped"; return 3; }
  echo "[codex] registering marketplace $REPO"
  if codex plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    :
  else
    if ! run codex plugin marketplace add "$REPO"; then
      if ! codex plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
        echo "[codex] marketplace registration failed" >&2
        return 1
      fi
    fi
  fi
  # Codex plugin add is intentionally run unconditionally; it is the repair/reinstall path too.
  run codex plugin add "$PLUGIN@$MARKETPLACE"
  echo "[codex] installed $PLUGIN@$MARKETPLACE"
  codex_bootstrap
}

install_antigravity() {
  command -v agy >/dev/null 2>&1 || { echo "[antigravity] agy CLI not found; skipped"; return 3; }
  run agy plugin install "https://github.com/$REPO"
  echo "[antigravity] installed https://github.com/$REPO (auto-activation delivered by the plugin PreInvocation hook)"
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
