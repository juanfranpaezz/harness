# Prerequisites only. This script never starts the harness installer.
Write-Output 'BOOTSTRAP STARTED'
Write-Output "LanguageMode: $($ExecutionContext.SessionState.LanguageMode)"
$ErrorActionPreference = 'Stop'
$DryRun = $false
$Unattended = $false
$Yes = $false
$WithCodex = $false
$NoEditor = $false
$NoCodex = $false
$AnswersFile = $null
$SummaryJson = $null
$ManifestPath = Join-Path $PSScriptRoot 'prereqs-windows.tsv'
$ids = @('git', 'node', 'python', 'claude', 'gh', 'codex', 'vscode', 'vscode-ext-claude-code', 'vscode-ext-codex')
$required = @('git', 'node', 'python', 'claude', 'gh')
$names = @{'git'='Git'; 'node'='Node.js'; 'python'='Python'; 'claude'='Claude Code'; 'gh'='GitHub CLI'; 'codex'='Codex CLI'; 'vscode'='Visual Studio Code'; 'vscode-ext-claude-code'='Claude Code extension for Visual Studio Code'; 'vscode-ext-codex'='Codex extension for Visual Studio Code'}
$extensions = @{'vscode-ext-claude-code' = 'anthropic.claude-code'; 'vscode-ext-codex' = 'openai.chatgpt'}

# Parse explicitly so invalid arguments consistently return the contract's exit 2.
try {
    for ($i = 0; $i -lt $args.Count; $i++) {
        switch ($args[$i]) {
            '-DryRun' { $DryRun = $true }
            '-Unattended' { $Unattended = $true }
            { $_ -in @('-Yes', '-NonInteractive') } { $Yes = $true }
            '-WithCodex' { $WithCodex = $true }
            { $_ -in @('-NoEditor', '--no-editor') } { $NoEditor = $true }
            { $_ -in @('-NoCodex', '--no-codex') } { $NoCodex = $true }
            { $_ -in @('-AnswersFile', '-ManifestPath', '-SummaryJson') } {
                $name = $args[$i]
                $i++
                if ($i -ge $args.Count -or $args[$i] -like '-*') { throw "Missing value for $name" }
                switch ($name) {
                    '-AnswersFile' { $AnswersFile = $args[$i] }
                    '-ManifestPath' { $ManifestPath = $args[$i] }
                    '-SummaryJson' { $SummaryJson = $args[$i] }
                }
            }
            default { throw "Unknown parameter: $($args[$i])" }
        }
    }
    $lines = @(Get-Content -LiteralPath $ManifestPath)
    if ($lines.Count -ne 10 -or $lines[0] -cne "id`tprobe`tmin_version`troute`tscope`televation`tsource") { throw 'Bad manifest header or row count' }
    $rows = @($lines | ConvertFrom-Csv -Delimiter "`t")
    $seen = @()
    foreach ($row in $rows) {
        if ($row.id -cnotin $ids -or $row.id -in $seen) { throw 'Bad or duplicate prerequisite id' }
        $seen += $row.id
        foreach ($field in @('probe', 'min_version', 'route', 'scope', 'elevation', 'source')) {
            if (-not $row.$field) { throw "Empty manifest field: $field" }
        }
        # Routes are argv, never shell programs. Unsupported routes must be manual.
        if ($row.route -ne 'ROUTE-PENDING' -and $row.route -notmatch '^(winget install|code --install-extension)( [A-Za-z0-9@._/-]+)+$') { throw "Unsupported route: $($row.id)" }
        if ($row.id -in @('node', 'python') -and $row.min_version -ne @{node='22'; python='3.10'}[$row.id]) { throw 'Unsupported minimum version' }
    }
    foreach ($line in $lines | Select-Object -Skip 1) {
        if (($line -split "`t").Count -ne 7) { throw 'Bad manifest column count' }
    }
    $answers = @{}
    if ($AnswersFile) {
        foreach ($line in Get-Content -LiteralPath $AnswersFile) {
            if (-not $line.Trim()) { continue }
            if ($line -notmatch '^([a-z-]+)=(.*)$' -or $Matches[1] -notin $ids) { throw 'Bad answers file' }
            if ($answers.ContainsKey($Matches[1])) { throw 'Duplicate answer' }
            $answers[$Matches[1]] = $Matches[2].Trim()
        }
    }
    if ($SummaryJson) {
        $parent = Split-Path -Parent $SummaryJson
        if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Summary directory does not exist' }
    }
} catch {
    Write-Output "BOOTSTRAP ERROR: $_"
    exit 2
}

if ($Yes -and -not $WithCodex) { $NoCodex = $true }

function Invoke-BootstrapProcess {
    param($Command, $Arguments, $Timeout = 20, [switch]$LiveOutput)
    $outFile = $null
    $errFile = $null
    $process = $null
    try {
        $resolved = Get-Command $Command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $resolved) { return @{exit_code=$null; text='Command unavailable'; ok=$false} }
        if (-not $LiveOutput) {
            $scratch = "harness-bootstrap-$PID-$(Get-Random)"
            $outFile = New-Item -ItemType File -Path (Join-Path $env:TEMP "$scratch.stdout")
            $errFile = New-Item -ItemType File -Path (Join-Path $env:TEMP "$scratch.stderr")
        }
        $executable = $resolved.Source
        $nativeArgs = $Arguments
        if ($executable -match '\.(cmd|bat)$') {
            $nativeArgs = "/d /s /c `"`"$executable`" $Arguments`""
            $executable = $env:ComSpec
        }
        if ($LiveOutput) {
            # Inherit the console so installation progress and Windows approval stay visible.
            $process = Start-Process -FilePath $executable -ArgumentList $nativeArgs -PassThru -NoNewWindow
        } else {
            $process = Start-Process -FilePath $executable -ArgumentList $nativeArgs -PassThru -NoNewWindow -RedirectStandardOutput $outFile.FullName -RedirectStandardError $errFile.FullName
        }
        $processHandle = $process.Handle
        $finished = $process | Wait-Process -Timeout $Timeout -ErrorAction SilentlyContinue
        if (-not $process.HasExited) {
            # Terminate the timed-out native process and its children, including cmd shims.
            try { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F 2>$null | Out-Null }
            catch { Write-Output 'BOOTSTRAP RESTRICTED: process-tree termination unavailable' | Out-Host }
            if (-not $process.HasExited) { Stop-Process -InputObject $process -Force -ErrorAction SilentlyContinue }
            return @{exit_code=$null; text='Probe timed out'; ok=$false; timed_out=$true}
        }
        $code = $process.ExitCode
        if ($LiveOutput) { return @{exit_code=$code; text="$Command exited $code"; ok=($null -ne $code -and $code -eq 0)} }
        $output = ((Get-Content -LiteralPath $outFile.FullName -Raw -ErrorAction SilentlyContinue), (Get-Content -LiteralPath $errFile.FullName -Raw -ErrorAction SilentlyContinue)) -join "`n"
        return @{exit_code=$code; text=$output.Trim(); ok=($null -ne $code -and $code -eq 0)}
    } catch {
        $code = $null
        if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { $code = 1223 }
        Write-Output "BOOTSTRAP RESTRICTED: native command $Command ($_; $($_.InvocationInfo.PositionMessage))" | Out-Host
        return @{exit_code=$code; text="$_"; ok=$false}
    } finally {
        if ($outFile) { Remove-Item -LiteralPath $outFile.FullName -ErrorAction SilentlyContinue }
        if ($errFile) { Remove-Item -LiteralPath $errFile.FullName -ErrorAction SilentlyContinue }
    }
}

function Test-Prerequisite {
    param($Id)
    $command = $Id
    if ($Id -eq 'python') {
        $command = 'py'
        if (-not (Get-Command py -CommandType Application -ErrorAction SilentlyContinue)) { $command = 'python' }
    }
    if ($Id -eq 'vscode' -or $extensions.ContainsKey($Id)) { $command = 'code' }
    $arguments = '--version'
    if ($Id -eq 'python') { $arguments = '-c "import sys; print(sys.version.split()[0]); assert hasattr(sys, ''stdlib_module_names''); print(''PYTHON-OK'')"' }
    if ($extensions.ContainsKey($Id)) { $arguments = '--list-extensions --show-versions' }
    $resolved = Get-Command $command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $resolved) { return @{present=$false; exit_code=$null; version=$null; reason='Command unavailable'} }
    $result = Invoke-BootstrapProcess $resolved.Source $arguments -Timeout 30
    if ($result.timed_out) {
        $result = Invoke-BootstrapProcess $resolved.Source $arguments -Timeout 30
        if ($result.timed_out -and -not $extensions.ContainsKey($Id)) {
            Write-Output "WARNING $($Id): version probe timed out twice; executable resolved at $($resolved.Source); counted present" | Out-Host
            return @{present=$true; exit_code=$null; version=$null; reason='Resolved executable; version probe timed out'}
        }
    }
    $version = $null
    $present = $result.ok -and $result.text -match '\d+\.\d+'
    if ($present) { $version = ($result.text -split "`r?`n")[0] }
    if ($Id -eq 'python') { $present = $result.ok -and $result.text -match '(?m)^PYTHON-OK\r?$' }
    if ($extensions.ContainsKey($Id)) {
        $extension = $extensions[$Id]
        $installedExtension = @($result.text -split "`r?`n" | Where-Object { $_ -eq $extension -or $_ -like "$extension@*" })
        $present = $result.ok -and $installedExtension.Count -gt 0
        $version = $null
        if ($present -and $installedExtension[0] -match '@(.+)$') { $version = $Matches[1] }
    }
    if ($Id -eq 'node') {
        $present = $result.ok -and $result.text -match '(?m)^v(\d+)\.\d+\.\d+\r?$'
        if ($present) { $present = ($Matches[1] -as 'int') -ge 22 }
        if ($present) {
            $result = Invoke-BootstrapProcess node '--experimental-vm-modules -e "const vm=require(''vm''); const m=new vm.SourceTextModule(''import x from \"bootstrap-probe\"''); if(m.dependencySpecifiers[0]!==''bootstrap-probe'')process.exit(1); console.log(''ADMISSION-OK'')"'
            $present = $result.ok -and $result.text -match '(?m)^ADMISSION-OK\r?$'
        }
    }
    return @{present=$present; exit_code=$result.exit_code; version=$version; reason=$result.text}
}

function Update-BootstrapPath {
    $entries = @($env:PATH -split ';')
    foreach ($key in @('HKCU:\Environment', 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment')) {
        try {
            $value = Get-ItemProperty -LiteralPath $key -Name Path -ErrorAction Stop
            $entries += $value.Path -split ';'
        } catch { Write-Output "BOOTSTRAP RESTRICTED: PATH refresh for $key ($_)" }
    }
    $unique = @()
    foreach ($entry in $entries) {
        if ($entry -and $entry -notin $unique) { $unique += $entry }
    }
    $env:PATH = $unique -join ';'
}

$interactive = $false
if (-not $Yes -and -not $Unattended -and -not $env:CI) {
    try {
        # Read-only property access is supported in ConstrainedLanguage. No type
        # literal or method call is needed; RawUI alone misidentifies redirected input.
        $consoleType = 'System.Console' -as 'type'
        $interactive = -not ($consoleType::IsInputRedirected -or $consoleType::IsOutputRedirected)
    } catch { $interactive = $false }
}
$items = @()
foreach ($row in $rows) {
    $id = $row.id
    $skip = ($id -notin $required -and -not $interactive -and -not $Yes) -or ($NoEditor -and $id -in @('vscode', 'vscode-ext-claude-code', 'vscode-ext-codex')) -or ($NoCodex -and $id -in @('codex', 'vscode-ext-codex'))
    if ($skip) {
        $items += @{id=$id; status='declined'; exit_code=$null; version=$null}
        continue
    }
    $probe = Test-Prerequisite $id
    $item = @{id=$id; status='present'; exit_code=$probe.exit_code; version=$probe.version}
    if (-not $probe.present) {
        Write-Output "$($names[$id]) ($id) prerequisite; scope: $($row.scope); Windows administrator approval: $($row.elevation)"
        Write-Output "Probe: $($probe.reason)"
        if ($row.route -eq 'ROUTE-PENDING') {
            $item.status = 'manual'
            Write-Output "Manual route: docs/harness/INSTALL.md ($id)"
            Write-Output "PREREQ ${id}: FAILED no automated route in manifest"
        } elseif ($extensions.ContainsKey($id) -and -not (Get-Command code -CommandType Application -ErrorAction SilentlyContinue)) {
            $item.status = 'manual'
            Write-Output "Manual route: docs/harness/INSTALL.md ($id needs code on PATH)"
            Write-Output "PREREQ ${id}: FAILED needs code on PATH"
        } else {
            $answer = 'no'
            if ($Yes) { $answer = 'yes' }
            elseif ($answers.ContainsKey($id)) { $answer = $answers[$id] }
            elseif (-not $Unattended -and -not $AnswersFile -and $interactive) { $answer = Read-Host "Install $($names[$id]) ($id)? [y/N]" }
            if ($answer -notin @('y', 'yes')) { $item.status = 'declined' }
            elseif ($DryRun) {
                $item.status = 'would-install'
                Write-Output $row.route
            } else {
                $parts = $row.route -split ' '
                if ($Yes -and $parts[0] -eq 'winget') {
                    foreach ($flag in @('--accept-package-agreements', '--accept-source-agreements', '--silent')) {
                        if ($flag -notin $parts) { $parts += $flag }
                    }
                }
                # Installation may need longer than capability probes.
                $install = Invoke-BootstrapProcess $parts[0] ($parts[1..($parts.Count - 1)] -join ' ') 1200 -LiveOutput:$Yes
                $item.exit_code = $install.exit_code
                if ($install.exit_code -eq 1223) { $item.status = 'cancelled'; Write-Output "PREREQ ${id}: FAILED administrator approval cancelled (1223)" }
                elseif (-not $install.ok) { $item.status = 'install-failed'; Write-Output "PREREQ ${id}: FAILED $($install.text)" }
                else {
                    Update-BootstrapPath
                    $verified = Test-Prerequisite $id
                    $item.version = $verified.version
                    $item.status = 'installed-unverified'
                    if ($verified.present) {
                        $item.status = 'installed'
                        $version = $verified.version
                        if (-not $version) { $version = 'version unavailable' }
                        Write-Output "PREREQ ${id}: installed $version"
                    } else { Write-Output "PREREQ ${id}: FAILED recheck: $($verified.reason); exit: $($verified.exit_code)" }
                }
            }
        }
    }
    $items += $item
}
$deferred = @($items | Where-Object { $_.id -in @('git', 'node', 'python') -and $_.status -notin @('present', 'installed') } | ForEach-Object { $_.id })
$next = $null
foreach ($item in $items) { Write-Output "$($item.id): $($item.status)" }
if ($deferred.Count -eq 0) {
    $next = 'node .claude/global-layer/harness-install.mjs install --config-dir "<config-dir>" --personal-terms "<terms-file>"'
    Write-Output "NEXT: $next"
} else { Write-Output "DEFERRED: harness install (needs: $($deferred -join ', '))" }
if ($SummaryJson) {
    try {
        $json = @{schema='harness-bootstrap-summary/1'; os='windows'; dry_run=$DryRun; items=@($items); next=$next; deferred=@($deferred)} | ConvertTo-Json -Depth 5
        # ASCII with JSON Unicode escapes is BOM-free UTF-8, including in
        # ConstrainedLanguage where constructing a .NET encoder is unavailable.
        $json = -join $(foreach ($character in $json.ToCharArray()) {
            if ([int]$character -gt 127) { '\u{0:x4}' -f [int]$character } else { $character }
        })
        Set-Content -LiteralPath $SummaryJson -Value $json -Encoding ASCII
    } catch { Write-Output "BOOTSTRAP ERROR: summary write failed ($_)"; exit 2 }
}
$failed = @($items | Where-Object { $_.id -in $required -and $_.status -notin @('present', 'installed') } | ForEach-Object { $_.id })
if ($failed.Count) { Write-Output "REQUIRED PREREQUISITES FAILED: $($failed -join ', ')"; exit 3 }
exit 0
