# Deploy = push to GitHub, from where the platform picks the project up by itself.
#
# The script exists for one step: the check that a deploy did not carry away the directories
# the platform does not know about. Its export owns the whole repository root and deletes
# docs/, tests/ and tools/ entirely; every deploy collides that deletion with our own work.
# It is always resolved the same way, and that is exactly why this is a script and not a
# paragraph in a manual: a paragraph gets forgotten once, and the loss goes to GitHub unseen.
#
# The rules and the reasoning: docs/deploy.md
#
# Messages are in English on purpose. Windows PowerShell writes to the console in its code
# page, and a message that has to be read at the moment something breaks must not depend on
# which one that is.

$ErrorActionPreference = "Stop"

# ── Why git is called through a wrapper ──
# git writes progress to stderr even when it succeeds ("To https://github.com/…" on a push).
# With ErrorActionPreference=Stop and a 2>&1 redirect PowerShell turns that into an
# ErrorRecord, so a perfectly good deploy printed a wall of red NativeCommandError. A script
# that cries wolf on success teaches people to ignore its output, which defeats the one job
# it has. Exit codes are checked explicitly instead — they are the only honest signal here.
#
# Named RunGit and calling git.exe on purpose: PowerShell resolves names case-insensitively,
# so a function called Git that runs `git` calls itself until the call depth blows up.
function RunGit {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & git.exe @args 2>&1 | Out-Host } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}

# Directories the export deletes and we restore from our side. Adding a directory that is not
# a project resource? Add it here AND to the table in docs/deploy.md — tests/run.js checks
# that the two agree, because a directory named in the rule but missing from the script is
# lost on the first deploy, silently.
$PROTECTED = @("docs", "tests", "tools")

function Fail($message) {
  Write-Host ""
  Write-Host "STOPPED: $message" -ForegroundColor Red
  exit 1
}

function Step($message) {
  Write-Host ""
  Write-Host "== $message" -ForegroundColor Cyan
}

# Make sure we are working on the repository and not on whatever directory we were called from.
$root = git rev-parse --show-toplevel 2>$null
if (-not $root) { Fail "not a git repository" }
Set-Location $root

# ── 1. Uncommitted work ──
# The merge touches the same files, so anything unsaved would be overwritten.
if (git status --porcelain) {
  git status --short
  Fail "the working tree has uncommitted changes. Commit or stash them and run again."
}

$before = git rev-parse HEAD

# ── 2. What the platform has sent back ──
Step "git fetch"
if ((RunGit fetch origin) -ne 0) { Fail "could not reach origin" }

$incoming = @(git log --oneline HEAD..origin/main)
$outgoing = @(git log --oneline origin/main..HEAD)

if ($incoming.Count -eq 0 -and $outgoing.Count -eq 0) {
  Write-Host "Nothing to deploy: the local branch matches origin/main." -ForegroundColor Green
  exit 0
}

$merging = $false
if ($incoming.Count -gt 0) {
  Write-Host "The platform has sent $($incoming.Count) commit(s):"
  $incoming | ForEach-Object { Write-Host "  $_" }

  Step "Merging the platform's export"
  # modify/delete conflicts on the protected directories are expected here, not a failure,
  # so the exit code is deliberately not checked: they are resolved right below.
  RunGit merge --no-commit --no-ff origin/main | Out-Null
  $merging = $true

  Step "Restoring the protected directories from our side"
  foreach ($dir in $PROTECTED) {
    # The directory may not have existed at that commit yet, and then there is nothing to take.
    git cat-file -e "${before}:$dir" 2>$null
    if ($LASTEXITCODE -eq 0) {
      git checkout $before -- $dir
      git add -- $dir
      Write-Host "  restored $dir/"
    }
  }
}

# ── 3. The check this script is for: nothing protected went missing ──
Step "Checking that the protected directories lost no files"
$deleted = @(git diff --cached --diff-filter=D --name-only $before -- $PROTECTED)
if ($deleted.Count -gt 0) {
  Write-Host "These files would disappear:" -ForegroundColor Red
  $deleted | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  Write-Host ""
  Write-Host "The merge is left unfinished. Resolve it by hand, or undo it with:" -ForegroundColor Yellow
  Write-Host "  git merge --abort" -ForegroundColor Yellow
  Fail "the deploy would have carried these files away"
}
Write-Host "  all present" -ForegroundColor Green

# ── 4. Tests ──
# Free, since we are here anyway: what is broken does not reach production.
Step "node tests/run.js"
node tests/run.js | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "The merge is left unfinished. Undo it with: git merge --abort" -ForegroundColor Yellow
  Fail "tests failed, deploy cancelled"
}

# ── 5. Commit the merge ──
if ($merging) {
  Step "Committing the merge"
  if ((RunGit commit -m "merge: keep docs, tests and tools, which the platform export deletes") -ne 0) { Fail "could not commit the merge" }
}

# ── 6. Deploy ──
Step "git push origin main - the platform takes it from there"
if ((RunGit push origin main) -ne 0) { Fail "could not push to origin" }

Write-Host ""
Write-Host "Done. HEAD = $(git rev-parse --short HEAD), the deploy is running." -ForegroundColor Green
