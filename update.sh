#!/usr/bin/env bash
set -euo pipefail
# Reinstall is the safest cross-host update path: marketplace metadata is refreshed where supported,
# and Antigravity documents reinstalling the same Git URL as an update path.
# All install.sh flags are accepted, including --auto-activate/--no-auto-activate/--dry-run. The
# managed Codex bootstrap block is replaced in place (never appended twice) when its text changes.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" "$@"
