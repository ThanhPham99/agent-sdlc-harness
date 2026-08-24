param(
  [Parameter(Mandatory=$false)][string]$Repo = 'ThanhPham99/agent-sdlc-harness',
  [ValidateSet('all','claude','codex','antigravity')][string]$HostName='all',
  [switch]$AutoActivate,
  [switch]$NoAutoActivate,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Plugin = 'agent-sdlc-harness'
$Marketplace = 'agent-sdlc-github'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Repo -notmatch '^[^/]+/[^/]+$') { throw 'Repo must be in OWNER/REPO format (e.g. ThanhPham99/agent-sdlc-harness)' }
if ($AutoActivate -and $NoAutoActivate) { throw 'Pass either -AutoActivate or -NoAutoActivate, not both' }
function Has($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Invoke-Step { param([string]$Exe,[string[]]$Arguments)
  if ($DryRun) { Write-Host "[dry-run] $Exe $($Arguments -join ' ')" } else { & $Exe @Arguments }
}
function Install-CodexBootstrap {
  # Claude Code and Antigravity get the bootstrap from plugin hooks. Codex needs the
  # managed block in $CODEX_HOME/AGENTS.md for strong activation; it is idempotent,
  # reversible and preserves surrounding user content.
  if ($NoAutoActivate) { Write-Host '[codex] auto-activation bootstrap skipped (soft skill discovery only)'; return }
  if (-not (Has 'node')) { Write-Host '[codex] node not found; managed bootstrap skipped (soft activation only)'; return }
  $script = Join-Path $Here 'scripts\codex-bootstrap.mjs'
  if (-not (Test-Path $script)) { Write-Host "[codex] $script not found; managed bootstrap skipped"; return }
  if ($DryRun) { & node $script install --dry-run } else { & node $script install }
}
function Install-Claude {
  if (-not (Has 'claude')) { Write-Host '[claude] CLI not found; skipped'; return }
  $list = (& claude plugin marketplace list 2>$null | Out-String)
  if ($list -match [regex]::Escape($Marketplace)) { Invoke-Step 'claude' @('plugin','marketplace','update',$Marketplace) }
  else { Invoke-Step 'claude' @('plugin','marketplace','add',$Repo) }
  Invoke-Step 'claude' @('plugin','install',"$Plugin@$Marketplace")
  Write-Host '[claude] auto-activation delivered by the plugin SessionStart hook'
}
function Install-Codex {
  if (-not (Has 'codex')) { Write-Host '[codex] CLI not found; skipped'; return }
  $list = (& codex plugin marketplace list 2>$null | Out-String)
  if ($list -notmatch [regex]::Escape($Marketplace)) { Invoke-Step 'codex' @('plugin','marketplace','add',$Repo) }
  Invoke-Step 'codex' @('plugin','add',"$Plugin@$Marketplace")
  Install-CodexBootstrap
}
function Install-Antigravity {
  if (-not (Has 'agy')) { Write-Host '[antigravity] agy CLI not found; skipped'; return }
  Invoke-Step 'agy' @('plugin','install',"https://github.com/$Repo")
  Write-Host '[antigravity] auto-activation delivered by the plugin PreInvocation hook'
}
switch ($HostName) {
  'claude' { Install-Claude }
  'codex' { Install-Codex }
  'antigravity' { Install-Antigravity }
  'all' { Install-Claude; Install-Codex; Install-Antigravity }
}
