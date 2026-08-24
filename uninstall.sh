#!/usr/bin/env bash
set -euo pipefail
PLUGIN="agent-sdlc-harness"
MARKETPLACE="agent-sdlc-github"
HOST="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    -h|--help) echo "Usage: ./uninstall.sh [--host claude|codex|antigravity|all]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
remove_claude(){ command -v claude >/dev/null 2>&1 || return 0; claude plugin uninstall "$PLUGIN@$MARKETPLACE" || true; }
remove_codex(){ command -v codex >/dev/null 2>&1 || return 0; codex plugin remove "$PLUGIN@$MARKETPLACE" || true; }
remove_agy(){ command -v agy >/dev/null 2>&1 || return 0; agy plugin uninstall "$PLUGIN" || true; }
case "$HOST" in
  claude) remove_claude;; codex) remove_codex;; antigravity|agy) remove_agy;;
  all) remove_claude; remove_codex; remove_agy;;
  *) echo "Unsupported host: $HOST" >&2; exit 2;;
esac
