# The PowerShell entry point. See bin/agent-sdlc.cmd for why these exist.
# $LASTEXITCODE is propagated because every caller reads the exit code: 0 is
# success, 2 is an unknown command, non-zero is a structured error.
$cli = Join-Path $PSScriptRoot '..\runtime\cli.mjs'
& node $cli $args
exit $LASTEXITCODE
