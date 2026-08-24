param(
  [Parameter(Mandatory=$true)][string]$Repo,
  [ValidateSet('all','claude','codex','antigravity')][string]$HostName='all'
)
$ErrorActionPreference = 'Stop'
$Plugin = 'agent-sdlc-harness'
$Marketplace = 'agent-sdlc-github'
if ($Repo -notmatch '^[^/]+/[^/]+$') { throw 'Repo must be OWNER/REPO' }
function Has($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Install-Claude {
  if (-not (Has 'claude')) { Write-Host '[claude] CLI not found; skipped'; return }
  $list = (& claude plugin marketplace list 2>$null | Out-String)
  if ($list -match [regex]::Escape($Marketplace)) { & claude plugin marketplace update $Marketplace }
  else { & claude plugin marketplace add $Repo }
  & claude plugin install "$Plugin@$Marketplace"
}
function Install-Codex {
  if (-not (Has 'codex')) { Write-Host '[codex] CLI not found; skipped'; return }
  $list = (& codex plugin marketplace list 2>$null | Out-String)
  if ($list -notmatch [regex]::Escape($Marketplace)) { & codex plugin marketplace add $Repo }
  & codex plugin add "$Plugin@$Marketplace"
}
function Install-Antigravity {
  if (-not (Has 'agy')) { Write-Host '[antigravity] agy CLI not found; skipped'; return }
  & agy plugin install "https://github.com/$Repo"
}
switch ($HostName) {
  'claude' { Install-Claude }
  'codex' { Install-Codex }
  'antigravity' { Install-Antigravity }
  'all' { Install-Claude; Install-Codex; Install-Antigravity }
}
