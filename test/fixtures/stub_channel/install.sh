#!/usr/bin/env bash
# A stand-in for hermes-suite-channel's install.sh, for test/hermes.test.ts.
#
# Same argument surface and the same observable contract as the real one at
# bda77344: refuses --token; reads the token from --token-file, else stdin;
# writes it 0600 to $HERMES_HOME/mcp-tokens/startup-suite-platform.runtime-token
# only when it changed; sets SUITE_* keys in .env in place (never the token);
# installs and enables the plugin; registers the stdio mcp_servers entry
# through `hermes config set` only for keys that differ; logs "already ..."
# on a no-op; ends stdout with exactly `hermes-suite-channel: installed`.
#
# Each call is recorded under $HOME/installer-calls/<n>/: argv (NUL separated),
# env (env -0), and stdin (only when the token came from stdin).
set -euo pipefail

log() { printf 'hermes-suite-channel: %s\n' "$*" >&2; }
die() { printf 'hermes-suite-channel: error: %s\n' "$*" >&2; exit 1; }

LOG="$HOME/installer-calls"
mkdir -p "$LOG"
n=$(find "$LOG" -mindepth 1 -maxdepth 1 -type d | wc -l)
CALL="$LOG/$((n + 1))"
mkdir -p "$CALL"
printf '%s\0' "$@" >"$CALL/argv"
env -0 >"$CALL/env"

URL="" RID="" HH="" TF="" HB="hermes" ALLOW="" USERS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --token | --token=*) die "--token is refused" ;;
    --url) URL="$2"; shift 2 ;;
    --runtime-id) RID="$2"; shift 2 ;;
    --hermes-home) HH="$2"; shift 2 ;;
    --token-file) TF="$2"; shift 2 ;;
    --hermes) HB="$2"; shift 2 ;;
    --allow-all-users) ALLOW=true; shift ;;
    --allowed-users) USERS="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
if [ -z "$URL" ] || [ -z "$RID" ] || [ -z "$HH" ]; then die "--url, --runtime-id and --hermes-home are required"; fi

TOKEN=""
if [ -n "$TF" ]; then
  IFS= read -r TOKEN <"$TF" || true
else
  IFS= read -r TOKEN || true
  printf '%s' "$TOKEN" >"$CALL/stdin"
fi
[ -n "$TOKEN" ] || die "the runtime token is empty"

mkdir -p "$HH/mcp-tokens"
TP="$HH/mcp-tokens/startup-suite-platform.runtime-token"
tmp="$(umask 077 && mktemp "$HH/mcp-tokens/.hsc-token.XXXXXX")"
printf '%s\n' "$TOKEN" >"$tmp"
chmod 600 "$tmp"
if [ -f "$TP" ] && cmp -s "$tmp" "$TP"; then
  rm -f "$tmp"
else
  mv -f "$tmp" "$TP"
  log "wrote the runtime token to $TP (mode 0600)"
fi
TOKEN=""

ENV_FILE="$HH/.env"
ENV_CHANGED=0
env_set() {
  local key="$1" value="$2" line out="" found=0 changed=0
  if [ -f "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      if [ "$found" = 0 ] && [[ "$line" == "$key="* ]]; then
        found=1
        [ "$line" = "$key=$value" ] || changed=1
        out+="$key=$value"$'\n'
      else
        out+="$line"$'\n'
      fi
    done <"$ENV_FILE"
  fi
  if [ "$found" = 0 ]; then out+="$key=$value"$'\n'; changed=1; fi
  if [ "$changed" = 1 ]; then
    printf '%s' "$out" >"$ENV_FILE.tmp"
    chmod 600 "$ENV_FILE.tmp"
    mv -f "$ENV_FILE.tmp" "$ENV_FILE"
    ENV_CHANGED=1
  fi
}
env_set SUITE_URL "$URL"
env_set SUITE_RUNTIME_ID "$RID"
env_set SUITE_RUNTIME_TOKEN_FILE "$TP"
[ -z "$ALLOW" ] || env_set SUITE_ALLOW_ALL_USERS "$ALLOW"
[ -z "$USERS" ] || env_set SUITE_ALLOWED_USERS "$USERS"
[ "$ENV_CHANGED" = 0 ] || log "wrote Suite settings to $ENV_FILE (mode 0600)"

SHA="$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" rev-parse HEAD)"
PD="$HH/plugins/startup-suite-platform"
BUILD="$PD/hermes_suite_channel/_build.py"
if [ -f "$BUILD" ] && grep -q "^BUILD = \"$SHA\"\$" "$BUILD"; then
  log "plugin startup-suite-platform already installed at $SHA"
else
  mkdir -p "$PD/hermes_suite_channel"
  printf 'name: startup-suite-platform\n' >"$PD/plugin.yaml"
  printf 'BUILD = "%s"\n' "$SHA" >"$BUILD"
  log "installing plugin startup-suite-platform at $SHA"
fi
if "$HB" config get plugins.enabled --json 2>/dev/null | grep -q '"startup-suite-platform"'; then
  log "plugin startup-suite-platform already enabled"
else
  "$HB" config set plugins.enabled '["startup-suite-platform"]' >&2
fi

MCP="$(printf '%s' "$URL" | sed -e 's#^wss://#https://#' -e 's#^ws://#http://#' -e 's#^\(https*://[^/]*\).*#\1/mcp#')"
want_cmd="/usr/bin/env"
want_args="[\"python3\",\"$PD/hermes_suite_channel/mcp_bridge.py\",\"--url\",\"$MCP\",\"--token-file\",\"$TP\"]"
have_cmd="$("$HB" config get mcp_servers.startup-suite.command 2>/dev/null || true)"
have_args="$("$HB" config get mcp_servers.startup-suite.args --json 2>/dev/null || true)"
[ "$have_cmd" = "$want_cmd" ] || "$HB" config set mcp_servers.startup-suite.command "$want_cmd" >&2
[ "$have_args" = "$want_args" ] || "$HB" config set mcp_servers.startup-suite.args "$want_args" >&2

log "restart the gateway to load it: hermes gateway restart"
printf '%s\n' "hermes-suite-channel: installed"
