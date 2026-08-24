#!/usr/bin/env bash
set -euo pipefail
PLUGIN="agent-sdlc-harness"
MARKETPLACE="agent-sdlc-github"
HOST="all"
DRY_RUN=0
KEEP_BOOTSTRAP=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --keep-bootstrap) KEEP_BOOTSTRAP=1; shift ;;
    -h|--help) echo "Usage: ./uninstall.sh [--host claude|codex|antigravity|all] [--dry-run] [--keep-bootstrap]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
run(){ if [[ "$DRY_RUN" -eq 1 ]]; then echo "[dry-run] $*"; else "$@" || true; fi }
remove_codex_bootstrap(){
  # Removes only the Agent SDLC managed block; other AGENTS.md content is preserved.
  [[ "$KEEP_BOOTSTRAP" -eq 1 ]] && { echo "[codex] managed bootstrap kept on request"; return 0; }
  command -v node >/dev/null 2>&1 || return 0
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$major" -lt 18 ]]; then
    echo "[codex] node $major is below the required engine floor (>=18); managed bootstrap left in place" >&2
    return 0
  fi
  local script="$HERE/scripts/codex-bootstrap.mjs"
  [[ -f "$script" ]] || return 0
  if [[ "$DRY_RUN" -eq 1 ]]; then node "$script" uninstall --dry-run || true; else node "$script" uninstall || true; fi
}
remove_claude(){ command -v claude >/dev/null 2>&1 || return 0; run claude plugin uninstall "$PLUGIN@$MARKETPLACE"; }
remove_codex(){ command -v codex >/dev/null 2>&1 || return 0; run codex plugin remove "$PLUGIN@$MARKETPLACE"; remove_codex_bootstrap; }
remove_agy(){ command -v agy >/dev/null 2>&1 || return 0; run agy plugin uninstall "$PLUGIN"; }
case "$HOST" in
  claude) remove_claude;; codex) remove_codex;; antigravity|agy) remove_agy;;
  all) remove_claude; remove_codex; remove_agy;;
  *) echo "Unsupported host: $HOST" >&2; exit 2;;
esac
