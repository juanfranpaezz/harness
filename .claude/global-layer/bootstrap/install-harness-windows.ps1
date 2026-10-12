[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceRepo,
    # OPTIONAL private data repository (personal layer and data gate). Without it the harness layer alone is installed.
    [string]$DataRepo,
    [string]$ConfigDir,
    [string]$SourceDir,
    [string]$DataDir,
    # Python 3 executable for the data gate and the post-install check; default: first working of py, python3, python.
    [string]$Python,
    # Offline MCP registry directory and Claude CLI for the MCP step (fixtures/tests); default: npm registry and `claude` on PATH.
    [string]$McpRegistry,
    [string]$McpClaude,
    [switch]$SkipPrereqs,
    [switch]$WithCodex,
    [switch]$SkipVsCode
)

$ErrorActionPreference = 'Stop'
# The Windows user profile decides every default path; PowerShell's $HOME is only a fallback when USERPROFILE is empty
# (a HOME variable that differs from the profile must never redirect the install to a second location).
$InstallHome = $env:USERPROFILE
if (-not $InstallHome) { $InstallHome = $HOME }
if (-not $ConfigDir) { $ConfigDir = Join-Path $InstallHome '.claude' }
if (-not $SourceDir) { $SourceDir = Join-Path $InstallHome 'harness-src' }
if (-not $DataDir) { $DataDir = Join-Path $InstallHome 'harness-data' }
$ConfigDir = [IO.Path]::GetFullPath($ConfigDir)
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$DataDir = [IO.Path]::GetFullPath($DataDir)
# Keep local origins usable when the printed update command runs from another directory.
if (Test-Path -LiteralPath $SourceRepo) { $SourceRepo = (Resolve-Path -LiteralPath $SourceRepo).Path }
$HasData = [bool]$DataRepo
if ($HasData -and (Test-Path -LiteralPath $DataRepo)) { $DataRepo = (Resolve-Path -LiteralPath $DataRepo).Path }

function Resolve-Tool([string]$Name) {
    $tool = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $tool) { throw "$Name is required but was not found on PATH" }
    return $tool.Source
}

function Invoke-Native([string]$Command, [string[]]$Arguments) {
    # Native stderr is diagnostic output, not a PowerShell terminating error.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # An ErrorRecord for an empty stderr line stringifies as its exception type name; use its message instead.
        $lines = @(& $Command @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
        })
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    return [pscustomobject]@{ Lines = $lines; Code = $code }
}

function Invoke-Required([string]$Command, [string[]]$Arguments) {
    $result = Invoke-Native $Command $Arguments
    $result.Lines | ForEach-Object { Write-Output $_ }
    if ($result.Code -ne 0) { throw "$(Split-Path -Leaf $Command) exited $($result.Code)" }
}

function Set-ScopedGitTrust {
    # Cloning a repository that another account (or an earlier install) owns makes Git stop with "detected dubious
    # ownership" unless safe.directory allows it. Allow it for this script's process tree only, through Git's
    # command-scope config environment (GIT_CONFIG_COUNT/KEY/VALUE, Git 2.31+). No gitconfig file is created or
    # edited, so the user's real global gitconfig is never touched; any entries already in the environment are kept.
    $count = 0
    if ($env:GIT_CONFIG_COUNT -and -not [int]::TryParse($env:GIT_CONFIG_COUNT, [ref]$count)) {
        throw "GIT_CONFIG_COUNT is not an integer: $env:GIT_CONFIG_COUNT"
    }
    if ($count -lt 0) { throw "GIT_CONFIG_COUNT is negative: $count" }
    Set-Item -LiteralPath "Env:GIT_CONFIG_KEY_$count" -Value 'safe.directory'
    Set-Item -LiteralPath "Env:GIT_CONFIG_VALUE_$count" -Value '*'
    $env:GIT_CONFIG_COUNT = [string]($count + 1)
}

function Resolve-Python3([string]$Requested) {
    # Probe by running it: on Windows `python`/`python3` can be Microsoft Store stubs that exist but never run.
    $candidates = @('py', 'python3', 'python')
    if ($Requested) { $candidates = @($Requested) }
    foreach ($candidate in $candidates) {
        $tool = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $tool) { continue }
        $probe = Invoke-Native $tool.Source @('--version')
        if ($probe.Code -eq 0 -and (($probe.Lines -join ' ') -match '^Python 3\.')) { return $tool.Source }
    }
    throw "Python 3 is required but no working interpreter was found (tried: $($candidates -join ', '))"
}

# Seconds per bounded version call in the STEP 1 re-check; HARNESS_TOOL_PROBE_SECONDS overrides it (tests only).
$ToolProbeSeconds = 30
if ($env:HARNESS_TOOL_PROBE_SECONDS) { $ToolProbeSeconds = [int]$env:HARNESS_TOOL_PROBE_SECONDS }

function Invoke-VersionProbe([string]$Path) {
    # One bounded `--version` call: the exit code, or $null when it timed out (its process tree is then ended).
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Path
    $info.Arguments = '--version'
    if ($Path -match '\.(cmd|bat)$') { $info.FileName = $env:ComSpec; $info.Arguments = "/d /s /c `"`"$Path`" --version`"" }
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $null = $process.StandardOutput.ReadToEndAsync()
    $null = $process.StandardError.ReadToEndAsync()
    if ($process.WaitForExit($ToolProbeSeconds * 1000)) { $process.WaitForExit(); return $process.ExitCode }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>&1 | Out-Null } catch { }
    finally { $ErrorActionPreference = $saved }
    if (-not $process.HasExited) { try { $process.Kill() } catch { } }
    return $null
}

function Test-RequiredTool([string]$ToolName) {
    # Resolve first, then a bounded version call with one retry. A resolved executable whose version call only times
    # out (load, low memory) counts as present with a warning, so an installed tool never triggers a reinstall.
    if ($ToolName -eq 'python') { $null = Resolve-Python3 $Python; return }
    $toolPath = Resolve-Tool $ToolName
    $code = $null
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $code = Invoke-VersionProbe $toolPath
        if ($code -eq 0) { return }
    }
    if ($null -eq $code) {
        Write-Output "WARNING ${ToolName}: version check timed out twice ($ToolProbeSeconds s each); found at $toolPath; counted present"
        return
    }
    throw "$ToolName exited $code"
}

function Refresh-Path {
    $entries = @($env:PATH -split ';')
    foreach ($scope in @('Machine', 'User')) {
        $entries += [Environment]::GetEnvironmentVariable('Path', $scope) -split ';'
    }
    $env:PATH = ($entries | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Quote-UpdateArgument([string]$Value) {
    # PowerShell single quotes preserve spaces, dollar signs and apostrophes literally.
    return "'" + $Value.Replace("'", "''") + "'"
}

$step = 1
$name = 'prerequisites'
try {
    Set-ScopedGitTrust
    if (-not $SkipPrereqs) {
        $bootstrap = Join-Path $PSScriptRoot 'harness-bootstrap.ps1'
        $manifest = Join-Path $PSScriptRoot 'prereqs-windows.tsv'
        foreach ($file in @($bootstrap, $manifest)) {
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required bootstrap file missing: $file" }
        }
        $bootstrapArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap,
            '-ManifestPath', $manifest, '-Yes')
        if ($WithCodex) { $bootstrapArgs += '-WithCodex' }
        else { $bootstrapArgs += '-NoCodex' }
        if ($SkipVsCode) { $bootstrapArgs += '-NoEditor' }
        # Inherit the console: do not capture or pipe installation output or Windows approval.
        & (Join-Path $PSHOME 'powershell.exe') @bootstrapArgs
        $bootstrapExit = $LASTEXITCODE
        Refresh-Path
        $missing = @()
        $installed = @()
        foreach ($toolName in @('git', 'node', 'python', 'claude', 'gh')) {
            try {
                Test-RequiredTool $toolName
                $installed += $toolName
            } catch { $missing += $toolName }
        }
        if ($missing.Count) { throw "required tools still missing or unusable: $($missing -join ', ') (bootstrap exit $bootstrapExit)" }
        if ($bootstrapExit -ne 0) { throw "bootstrap exited $bootstrapExit; see REQUIRED PREREQUISITES FAILED above" }
    }
    # Even -SkipPrereqs cannot bypass the tools needed for the very next steps.
    $git = Resolve-Tool 'git'
    Invoke-Required $git @('--version')
    $node = Resolve-Tool 'node'
    Invoke-Required $node @('--version')
    if (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue) {
        Write-Output 'Codex optional: installed'
    } else { Write-Output 'Codex optional: not installed' }
    $reason = "installed: $($installed -join ', ')"
    if ($SkipPrereqs) { $reason = 'installation skipped; git and node checked' }
    Write-Output "STEP 1/7 prerequisites: OK $reason"

    $step = 2; $name = 'source'
    if ((Test-Path -LiteralPath $SourceDir) -and
        (-not (Test-Path -LiteralPath $SourceDir -PathType Container) -or @(Get-ChildItem -LiteralPath $SourceDir -Force).Count -gt 0)) {
        if (-not (Test-Path -LiteralPath (Join-Path $SourceDir '.git'))) { throw "SourceDir is non-empty or not a directory and is not a git checkout: $SourceDir" }
        Invoke-Required $git @('-C', $SourceDir, 'pull', '--ff-only')
        Write-Output 'STEP 2/7 source: OK updated'
    } else {
        Invoke-Required $git @('clone', '--', $SourceRepo, $SourceDir)
        Write-Output 'STEP 2/7 source: OK cloned'
    }
    $layer = Join-Path $SourceDir '.claude\global-layer'

    $step = 3; $name = 'data'
    $terms = $null
    if (-not $HasData) {
        Write-Output 'STEP 3/7 data: SKIPPED (no data repository: the personal layer is optional)'
    } else {
        if (-not (Test-Path -LiteralPath $DataDir) -or
            ((Test-Path -LiteralPath $DataDir -PathType Container) -and @(Get-ChildItem -LiteralPath $DataDir -Force).Count -eq 0)) {
            Invoke-Required $git @('clone', '--', $DataRepo, $DataDir)
        } elseif (-not (Test-Path -LiteralPath (Join-Path $DataDir '.git'))) {
            throw "DataDir is non-empty or not a directory and is not a git checkout: $DataDir"
        }
        $terms = Join-Path $DataDir 'personal-terms.txt'
        if (-not (Test-Path -LiteralPath $terms -PathType Leaf)) { throw "Missing personal-terms.txt in $DataDir; harness installation stopped" }
        Write-Output 'STEP 3/7 data: OK personal-terms.txt exists'
    }

    $step = 4; $name = 'harness'
    $installArgs = @((Join-Path $layer 'harness-install.mjs'), 'install', '--config-dir', $ConfigDir,
        '--profile', 'full', '--with-hooks')
    if ($terms) { $installArgs += @('--personal-terms', $terms) }
    else {
        Write-Output 'NOTICE: no personal-terms list (no data repository); the leak check runs with an empty term list.'
        $installArgs += '--no-personal-terms'
    }
    Invoke-Required $node $installArgs
    Write-Output 'STEP 4/7 harness: OK full profile and hooks installed'

    $step = 5; $name = 'personal'
    if ($HasData) {
        Invoke-Required $node @((Join-Path $layer 'bootstrap.mjs'), '--personal',
            (Join-Path $DataDir 'ceo-model\ceo-model.md'), '--config-dir', $ConfigDir)
        $pythonExe = Resolve-Python3 $Python
        Invoke-Required $node @((Join-Path $layer 'bootstrap\data-repo-hooks.mjs'), 'install', '--data-repo', $DataDir,
            '--python', $pythonExe)
        Write-Output 'STEP 5/7 personal: OK personal layer and data gate installed'
    } else {
        # Python is still resolved here: the post-install check in step 7 needs it.
        $pythonExe = Resolve-Python3 $Python
        Write-Output 'STEP 5/7 personal: OK harness layer only (no data repository: personal layer and data gate skipped)'
    }

    $step = 6; $name = 'tools'
    $mcpDir = Join-Path $layer 'bootstrap\mcp'
    $mcpArgs = @((Join-Path $mcpDir 'install-mcp-servers.mjs'), '--home', $InstallHome, '--config-dir', $ConfigDir)
    if ($McpRegistry) { $mcpArgs += @('--registry', $McpRegistry) }
    if ($McpClaude) { $mcpArgs += @('--claude', $McpClaude) }
    $mcpCheck = Invoke-Native $node ($mcpArgs + @('--check'))
    if ($mcpCheck.Code -eq 0) {
        foreach ($line in $mcpCheck.Lines) { Write-Output $line }
        Write-Output "MCP servers already present and Connected in $ConfigDir"
    } else {
        Write-Output 'MCP pre-check: installation or registration needs repair'
        Invoke-Required $node ($mcpArgs + @('--ensure'))
    }
    # The VS Code CLI cannot create profiles, so STEP 6 installs the extension into the DEFAULT profile only;
    # the two harness profiles are an optional manual step described in docs/harness/INSTALL.md.
    $editor = 'MCP servers installed; VS Code step skipped (-SkipVsCode)'
    if (-not $SkipVsCode) {
        $codeTool = Get-Command code -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $codeTool) {
            $editor = 'MCP servers installed; VS Code extension SKIPPED (VS Code CLI not found)'
        } else {
            $profilesDir = Join-Path $layer 'bootstrap\vscode-profiles'
            $userData = Join-Path $env:APPDATA 'Code'
            Invoke-Required $node @((Join-Path $profilesDir 'setup-vscode-profiles.mjs'), '--mode', 'default',
                '--code', $codeTool.Source, '--user-data-dir', $userData)
            Invoke-Required $node @((Join-Path $profilesDir 'check-vscode-profiles.mjs'), '--mode', 'default',
                '--user-data-dir', $userData)
            $editor = 'extension installed (default profile); VS Code profiles: manual step (see docs/harness/INSTALL.md)'
        }
    }
    Write-Output "STEP 6/7 tools: OK $editor"

    $step = 7; $name = 'postinstall'
    $postinstallArgs = @((Join-Path $layer 'postinstall-check.mjs'), '--config-dir', $ConfigDir, '--python', $pythonExe)
    if ($McpClaude) { $postinstallArgs += @('--claude', $McpClaude) }
    $result = Invoke-Native $node $postinstallArgs
    $lines = @($result.Lines | Where-Object { $_.Trim().Length -gt 0 })
    $terminal = 'POSTINSTALL FAIL no final output'
    if ($lines.Count) {
        $terminal = $lines[-1]
        for ($i = 0; $i -lt $lines.Count - 1; $i++) { Write-Output $lines[$i] }
    }
    $passed = $result.Code -eq 0 -and $terminal -ceq 'POSTINSTALL PASS'
    if ($passed) { Write-Output 'STEP 7/7 postinstall: OK verified' }
    else { Write-Output "STEP 7/7 postinstall: FAIL checker exit $($result.Code); final line: $terminal" }
    $update = 'powershell -ExecutionPolicy Bypass -File ' + (Quote-UpdateArgument (Join-Path $layer 'bootstrap\install-harness-windows.ps1')) +
        ' -SourceRepo ' + (Quote-UpdateArgument $SourceRepo)
    if ($HasData) { $update += ' -DataRepo ' + (Quote-UpdateArgument $DataRepo) }
    $update += ' -ConfigDir ' + (Quote-UpdateArgument $ConfigDir) + ' -SourceDir ' + (Quote-UpdateArgument $SourceDir)
    if ($HasData) { $update += ' -DataDir ' + (Quote-UpdateArgument $DataDir) }
    $update += ' -SkipPrereqs'
    if ($SkipVsCode) { $update += ' -SkipVsCode' }
    foreach ($option in @('Python', 'McpRegistry', 'McpClaude')) {
        if ($PSBoundParameters.ContainsKey($option)) {
            $update += ' -' + $option + ' ' + (Quote-UpdateArgument ([string]$PSBoundParameters[$option]))
        }
    }
    Write-Output "UPDATE-COMMAND: $update"
    Write-Output $terminal
    if ($passed) { exit 0 }
    exit 1
} catch {
    $reason = "$_" -replace '[\r\n]+', ' '
    Write-Output "STEP $step/7 ${name}: FAIL $reason"
    if ($step -eq 1 -and -not $SkipPrereqs) { exit 3 }
    exit 1
}
