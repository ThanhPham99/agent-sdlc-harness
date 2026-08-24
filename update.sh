#!/usr/bin/env bash
set -euo pipefail
# Reinstall is the safest cross-host update path: marketplace metadata is refreshed where supported,
# and Antigravity documents reinstalling the same Git URL as an update path.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" "$@"
