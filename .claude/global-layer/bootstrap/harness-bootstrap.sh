#!/bin/sh
printf '%s\n' 'BOOTSTRAP STARTED'

# Manifests are reviewed local command files, not remote input. Probe cells are
# fixed identifiers, never executable expressions. No package routes are guessed.
usage_error() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
manifest=$script_dir/prereqs-posix.tsv
answers=
summary=
os=
dry_run=false
unattended=false
no_editor=false
no_codex=false
allow_root=false
while [ "$#" -gt 0 ]; do
    case $1 in
        --dry-run) dry_run=true; shift ;;
        --unattended) unattended=true; shift ;;
        --no-editor) no_editor=true; shift ;;
        --no-codex) no_codex=true; shift ;;
        --allow-root) allow_root=true; shift ;;
        --answers|--manifest|--summary-json|--os)
            [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "missing value for $1"
            case $1 in
                --answers) answers=$2 ;;
                --manifest) manifest=$2 ;;
                --summary-json) summary=$2 ;;
                --os) os=$2 ;;
            esac
            shift 2 ;;
        *) usage_error "unknown flag: $1" ;;
    esac
done
uid=$(id -u) || usage_error 'cannot determine user id'
case $uid in ''|*[!0-9]*) usage_error 'invalid user id' ;; esac
if [ "$uid" -eq 0 ] && [ "$allow_root" = false ]; then
    usage_error 'refusing to run as root; pass --allow-root to override'
fi
if [ -z "$os" ]; then
    case $(uname -s) in Linux) os=linux ;; Darwin) os=macos ;; *) usage_error 'use --os linux or --os macos' ;; esac
fi
case $os in linux|macos) ;; *) usage_error 'unsupported OS' ;; esac
[ -f "$manifest" ] && [ -r "$manifest" ] || usage_error 'manifest is not readable'

# Validate the entire manifest before even probing a tool. Empty TSV fields,
# duplicate ids and unsupported probe/elevation semantics are errors.
awk -F '\t' '
BEGIN {
    header="id\tprobe\tmin_version\troute_apt\troute_dnf\troute_brew\televation\tsource"
    n=split("git node python claude gh codex vscode vscode-ext-claude-code vscode-ext-codex", ids, " ")
    for (i=1;i<=n;i++) expected[ids[i]]=1
    probes["git"]="git"; probes["node"]="node"; probes["python"]="python3"
    probes["claude"]="claude"; probes["gh"]="gh"; probes["codex"]="codex"
    probes["vscode"]="code"; probes["vscode-ext-claude-code"]="code:anthropic.claude-code"
    probes["vscode-ext-codex"]="code:openai.chatgpt"
}
{ sub(/\r$/, "") }
NR==1 { if ($0!=header) bad=1; next }
{
    if (NF!=8 || !expected[$1] || seen[$1]++ || $2!=probes[$1]) bad=1
    for (i=1;i<=8;i++) if ($i=="") bad=1
    minimum=($1=="node" ? "22" : ($1=="python" ? "3.10" : "-"))
    if ($3!=minimum || $7 !~ /^(manager|sudo|none)$/) bad=1
    if ($0 ~ /[[:cntrl:]]/ && $0 ~ /\r/) bad=1
}
END { if (NR!=10) bad=1; exit bad ? 1 : 0 }
' "$manifest" || usage_error 'bad manifest (expected exactly nine prerequisite rows)'
if [ -n "$answers" ]; then
    [ -r "$answers" ] && [ -f "$answers" ] || usage_error 'answers file is not readable'
    awk '
    { sub(/\r$/, "") }
    /^[[:space:]]*$/ { next }
    !/^(git|node|python|claude|gh|codex|vscode|vscode-ext-claude-code|vscode-ext-codex)=(yes|no|y|n)$/ { bad=1 }
    { split($0,a,"="); if (seen[a[1]]++) bad=1 }
    END { exit bad ? 1 : 0 }
    ' "$answers" || usage_error 'bad or duplicate answer'
fi

interactive=false
if [ -t 0 ] && [ "$unattended" = false ]; then interactive=true; fi
bounded=false
if command -v timeout >/dev/null 2>&1; then bounded=true; fi
run_probe() {
    if [ "$bounded" = true ]; then timeout 10 "$@"; else "$@"; fi
}
detect() {
    version=
    probe_exit=null
    executable=${probe%%:*}
    command -v "$executable" >/dev/null 2>&1 || { probe_exit=127; return 1; }
    case $probe in
        code:*)
            output=$(run_probe code --list-extensions 2>/dev/null); probe_exit=$?
            [ "$probe_exit" -eq 0 ] || return 1
            extension=${probe#code:}
            printf '%s\n' "$output" | tr -d '\r' | awk -v wanted="$extension" 'tolower($0)==wanted { found=1 } END { exit !found }' || return 1
            version=$extension ;;
        *)
            version=$(run_probe "$executable" --version 2>/dev/null); probe_exit=$?
            [ "$probe_exit" -eq 0 ] && [ -n "$version" ] || return 1
            case $probe in
                node)
                    major=$(printf '%s\n' "$version" | sed -n '1s/^v\([0-9][0-9]*\)\..*/\1/p')
                    case $major in ''|*[!0-9]*) return 1 ;; esac
                    [ "$major" -ge 22 ] 2>/dev/null || return 1
                    output=$(run_probe node --experimental-vm-modules -e 'const vm = require("node:vm"); new vm.SourceTextModule("export const admission = true;"); console.log("ADMISSION-OK");' 2>/dev/null); probe_exit=$?
                    [ "$probe_exit" -eq 0 ] && [ "$output" = ADMISSION-OK ] || return 1 ;;
                python3)
                    output=$(run_probe python3 -c 'import sys; assert hasattr(sys, "stdlib_module_names"); print("ADMISSION-OK")' 2>/dev/null); probe_exit=$?
                    [ "$probe_exit" -eq 0 ] && [ "$output" = ADMISSION-OK ] || return 1 ;;
            esac ;;
    esac
    return 0
}
consent() {
    answer=
    if [ -n "$answers" ]; then
        answer=$(awk -F= -v wanted="$id" '{ sub(/\r$/, "") } $1==wanted { print $2 }' "$answers")
    elif [ "$interactive" = true ]; then
        printf 'Install %s (%s)? [y/N]\n' "$package_name" "$id"
        IFS= read -r answer || answer=
    fi
    printf 'Decision for %s: %s\n' "$id" "${answer:-no}"
    case $answer in y|yes) return 0 ;; *) return 1 ;; esac
}
shell_quote() {
    printf '%s' "$1" | awk '
    BEGIN { printf "%c",39 }
    { for (i=1;i<=length($0);i++) {
        c=substr($0,i,1)
        if (c==sprintf("%c",39)) printf "%c\\%c%c",39,39,39
        else printf "%s",c
    } }
    END { printf "%c",39 }'
}
manager=
if [ "$os" = linux ]; then
    if command -v apt-get >/dev/null 2>&1; then manager=apt
    elif command -v dnf >/dev/null 2>&1; then manager=dnf; fi
elif command -v brew >/dev/null 2>&1; then manager=brew
fi

# Explicit downloaded-script route grammar: download-script https://URL
# Raw download commands are refused. A file is retained for inspection; its hash
# is informational, not a claim of publisher authenticity. Second consent is
# always interactive and cannot be supplied by the first answers-file decision.
install_route() {
    case $route in
        'download-script https://'* )
            url=${route#download-script }
            case $url in *[[:space:]]*) status=manual; return ;; esac
            if [ "$interactive" != true ]; then
                printf '%s\n' 'Second script consent requires a terminal; see docs/harness/INSTALL.md'
                status=manual; return
            fi
            command -v curl >/dev/null 2>&1 || { status=manual; return; }
            if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum
            elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum
            else status=manual; return; fi
            download_dir=$(mktemp -d "${TMPDIR:-/tmp}/harness-bootstrap.XXXXXXXX") || { status=install-failed; return; }
            script_file=$download_dir/installer.sh
            curl --fail --location --proto '=https' --proto-redir '=https' --output "$script_file" "$url"
            install_exit=$?
            [ "$install_exit" -eq 0 ] || { status=install-failed; return; }
            if [ "$hash_tool" = sha256sum ]; then digest=$(sha256sum "$script_file")
            else digest=$(shasum -a 256 "$script_file"); fi
            install_exit=$?
            [ "$install_exit" -eq 0 ] || { status=install-failed; return; }
            printf 'SHA256: %s\nRun downloaded script for %s? [y/N]\n' "$digest" "$id"
            IFS= read -r answer || answer=
            case $answer in y|yes) ;; *) status=declined; return ;; esac
            if [ "$needs_sudo" = yes ]; then sudo sh "$script_file"; else sh "$script_file"; fi
            install_exit=$? ;;
        *curl*|*wget*|*'|'*|*'download-script'*)
            printf '%s\n' 'Unreviewed download route; see docs/harness/INSTALL.md'
            status=manual; return ;;
        *)
            if [ "$needs_sudo" = yes ]; then sudo sh -c "$route"; else sh -c "$route"; fi
            install_exit=$? ;;
    esac
    if [ "$install_exit" -ne 0 ]; then status=install-failed
    elif detect; then status=installed
    else status=installed-unverified; fi
}
json_string() {
    printf '%s' "$1" | awk '
    BEGIN { printf "\"" }
    {
        if (NR>1) printf "\\n"
        for (i=1;i<=length($0);i++) {
            c=substr($0,i,1)
            if (c=="\\") printf "\\\\"
            else if (c=="\"") printf "\\\""
            else {
                escaped=0
                for (j=1;j<32;j++) if (c==sprintf("%c",j)) { printf "\\u%04x",j; escaped=1; break }
                if (!escaped) printf "%s",c
            }
        }
    }
    END { printf "\"" }'
}
items=
status_lines=
separator=
deferred=
deferred_json=
result=0
tab=$(printf '\t')
# A separate descriptor preserves stdin for consent and keeps aggregate state
# in the parent shell. Prompt reads must never consume another manifest row.
while IFS="$tab" read -r id probe minimum route_apt route_dnf route_brew elevation source <&3 || [ -n "$id" ]; do
    [ "$id" = id ] && continue
    case $id in
        git) package_name='Git' ;;
        node) package_name='Node.js' ;;
        python) package_name='Python' ;;
        claude) package_name='Claude Code' ;;
        gh) package_name='GitHub CLI' ;;
        codex) package_name='Codex CLI' ;;
        vscode) package_name='Visual Studio Code' ;;
        vscode-ext-claude-code) package_name='Claude Code extension for Visual Studio Code' ;;
        vscode-ext-codex) package_name='Codex extension for Visual Studio Code' ;;
    esac
    status=
    version=
    probe_exit=null
    install_exit=null
    optional=false
    case $id in codex|vscode|vscode-ext-*) optional=true ;; esac
    skip=false
    if [ "$optional" = true ] && [ "$interactive" = false ]; then skip=true; fi
    if [ "$no_editor" = true ]; then case $id in vscode|vscode-ext-*) skip=true ;; esac; fi
    if [ "$no_codex" = true ]; then case $id in codex|vscode-ext-codex) skip=true ;; esac; fi
    if [ "$skip" = true ]; then
        status=declined
        printf '%s: optional row skipped\n' "$id"
    elif detect; then status=present
    else
        case $manager in apt) route=$route_apt ;; dnf) route=$route_dnf ;; brew) route=$route_brew ;; *) route=ROUTE-PENDING ;; esac
        # Extension installation uses the existing code executable, not a system
        # package manager. A reviewed route is still required in the manifest.
        case $probe in code:*) if [ "$os" = macos ]; then route=$route_brew; else route=$route_apt; fi ;; esac
        needs_sudo=no
        case $elevation in sudo) needs_sudo=yes ;; manager) case $manager in apt|dnf) needs_sudo=yes ;; esac ;; esac
        printf 'Package: %s (%s); sudo required: %s\n' "$package_name" "$id" "$needs_sudo"
        if [ "${probe#code:}" != "$probe" ] && ! command -v code >/dev/null 2>&1; then
            printf '%s\n' 'VS Code command is unavailable; see docs/harness/INSTALL.md'
            status=manual
        elif [ "$route" = ROUTE-PENDING ]; then
            printf '%s: route or package manager unavailable; see docs/harness/INSTALL.md\n' "$id"
            status=manual
        elif ! consent; then status=declined
        elif [ "$dry_run" = true ]; then
            status=would-install
            if [ "$needs_sudo" = yes ]; then printf 'COMMAND: sudo sh -c %s\n' "$(shell_quote "$route")"
            else printf 'COMMAND: sh -c %s\n' "$(shell_quote "$route")"; fi
        elif [ "$needs_sudo" = yes ] && ! command -v sudo >/dev/null 2>&1; then
            printf '%s\n' 'sudo is unavailable; see docs/harness/INSTALL.md'
            status=manual
        else install_route
        fi
    fi
    status_lines="$status_lines$id: $status
"
    case $status in present|installed) ;;
        *)
            [ "$optional" = true ] || result=3
            case $id in git|node|python)
                if [ -n "$deferred" ]; then deferred="$deferred $id"; deferred_json="$deferred_json,"; else deferred=$id; fi
                deferred_json="$deferred_json\"$id\"" ;;
            esac ;;
    esac
    version_json=null
    [ -z "$version" ] || version_json=$(json_string "$version")
    item_exit=$probe_exit
    [ "$install_exit" = null ] || item_exit=$install_exit
    items="$items$separator{\"id\":\"$id\",\"status\":\"$status\",\"exit_code\":$item_exit,\"version\":$version_json}"
    separator=,
done 3< "$manifest"

printf '%s' "$status_lines"
printf 'Probe timeout available: %s\n' "$bounded"
[ "$bounded" = true ] || printf '%s\n' 'WARNING: timeout unavailable; probes ran unbounded.'
next_json=null
if [ -z "$deferred" ]; then
    # docs/harness/INSTALL.md:34; never execute the installer from this stage.
    next='node .claude/global-layer/harness-install.mjs install --config-dir "<config-dir>" --personal-terms "<terms-file>"'
    printf 'NEXT: %s\n' "$next"
    next_json=$(json_string "$next")
else printf 'DEFERRED: harness install (needs: %s)\n' "$deferred"
fi
if [ -n "$summary" ]; then
    printf '{"schema":"harness-bootstrap-summary/1","os":"%s","dry_run":%s,"items":[%s],"next":%s,"deferred":[%s]}\n' \
        "$os" "$dry_run" "$items" "$next_json" "$deferred_json" > "$summary" || usage_error 'cannot write summary'
fi
exit "$result"
