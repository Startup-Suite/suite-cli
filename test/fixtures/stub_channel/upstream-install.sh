#!/usr/bin/env bash
# A stand-in for hermes-agent's scripts/install.sh, for test/hermes.test.ts.
# Records its argv and HERMES_HOME, then publishes a launcher at
# $HERMES_HOME/hermes-agent/.hermes/bin/hermes that execs the stub hermes
# named in $HOME/stub-hermes-path.
set -euo pipefail
printf '%s\0' "$@" >"$HOME/upstream-installer.argv"
printf '%s' "${HERMES_HOME:-}" >"$HOME/upstream-installer.hermes_home"
home=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hermes-home) home="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$home" ] || { echo "no --hermes-home" >&2; exit 2; }
mkdir -p "$home/hermes-agent/.hermes/bin"
stub="$(cat "$HOME/stub-hermes-path")"
printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$stub" >"$home/hermes-agent/.hermes/bin/hermes"
chmod +x "$home/hermes-agent/.hermes/bin/hermes"
echo "Hermes Agent install complete. Run: hermes" >&2
