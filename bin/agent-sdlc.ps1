# The PowerShell entry point. See bin/agent-sdlc.cmd for why these exist.
# $ErrorActionPreference='Stop' turns a failed launch (e.g. node missing from
# PATH) into a terminating error -- without it, `& node` raises a non-terminating
# CommandNotFoundException, execution falls through to `exit $LASTEXITCODE` with
# $LASTEXITCODE unset ($null), and `exit $null` is exit 0, so a missing-Node
# environment would read as success.
$ErrorActionPreference='Stop'
$cli = Join-Path $PSScriptRoot '..\runtime\cli.mjs'
& node $cli $args
# $LASTEXITCODE is propagated because every caller reads the exit code: 0 is
# success, 2 is an unknown command, non-zero is a structured error.
exit $LASTEXITCODE
