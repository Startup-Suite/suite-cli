#!/bin/sh
# suite-cli installer. POSIX sh only: this runs via
#   curl -fsSL https://raw.githubusercontent.com/Startup-Suite/suite-cli/main/install.sh | sh
# before anything is installed on the machine, including bun. No bashisms,
# no arrays, no [[ ]], and no sudo anywhere.
set -eu

REPO="Startup-Suite/suite-cli"
REF="${SUITE_CLI_REF:-main}"
TARBALL_URL="${SUITE_CLI_TARBALL_URL:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}}"

TMPDIR_SUITE=""

# ---------------------------------------------------------------- output ----
# ASCII only, colour optional: nothing is known about this terminal yet.
# Two-column label/value grid, two-space indent.
LABEL_WIDTH=18

row() {
	# row <label> <value>
	printf '  %-*s%s\n' "$LABEL_WIDTH" "$1" "$2"
}

note() {
	printf '  %s\n' "$1"
}

# Every failure exits non-zero naming the step that failed.
die() {
	printf '\n  install failed: %s\n' "$1" >&2
	exit 1
}

cleanup() {
	if [ -n "$TMPDIR_SUITE" ] && [ -d "$TMPDIR_SUITE" ]; then
		rm -rf "$TMPDIR_SUITE"
	fi
}
trap cleanup EXIT INT HUP TERM

# -------------------------------------------------------------- platform ----
detect_platform() {
	uname_s="$(uname -s 2>/dev/null || echo unknown)"
	case "$uname_s" in
	Darwin) echo "macOS" ;;
	Linux) echo "Linux" ;;
	MINGW* | MSYS* | CYGWIN* | Windows_NT)
		die "Windows is not supported. suite-cli supports macOS and Linux only."
		;;
	*)
		die "unsupported platform \"$uname_s\". suite-cli supports macOS and Linux only."
		;;
	esac
}

# ------------------------------------------------------------ install dir ----
resolve_bin_dir() {
	if [ -n "${XDG_BIN_HOME:-}" ]; then
		echo "$XDG_BIN_HOME"
	else
		echo "$HOME/.local/bin"
	fi
}

resolve_lib_dir() {
	if [ -n "${XDG_DATA_HOME:-}" ]; then
		echo "$XDG_DATA_HOME/suite/cli"
	else
		echo "$HOME/.local/share/suite/cli"
	fi
}

# Print a path with $HOME collapsed to ~, for display only.
pretty_path() {
	case "$1" in
	"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
	*) printf '%s' "$1" ;;
	esac
}

on_path() {
	# on_path <dir> -- true when dir is an element of $PATH
	_needle="$1"
	_ifs="$IFS"
	IFS=:
	for _entry in ${PATH:-}; do
		if [ "$_entry" = "$_needle" ]; then
			IFS="$_ifs"
			return 0
		fi
	done
	IFS="$_ifs"
	return 1
}

# ------------------------------------------------------------------ fetch ----
fetch() {
	# fetch <url> <dest-file>. Downloads to the caller's temp path only; the
	# caller moves it into place. A partial file must never reach the
	# destination.
	if command -v curl >/dev/null 2>&1; then
		# --fail turns an HTTP error into a non-zero exit rather than a body.
		curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	else
		die "neither curl nor wget is available to download suite-cli"
	fi
}

# ----------------------------------------------------------------- prompt ----
# Reads a single line. When piped through sh the script itself owns stdin, so
# prefer the controlling terminal and fall back to stdin (which is what the
# tests drive).
ask() {
	# The prompt is printed by the caller so that it lands on stdout rather
	# than being swallowed by the command substitution reading this reply.
	_reply=""
	if [ -r /dev/tty ] && [ -t 0 ]; then
		IFS= read -r _reply </dev/tty || _reply=""
	else
		IFS= read -r _reply || _reply=""
	fi
	printf '%s' "$_reply"
}

# ------------------------------------------------------------------- main ----
platform="$(detect_platform)"
bin_dir="$(resolve_bin_dir)"
lib_dir="$(resolve_lib_dir)"
dest="$bin_dir/suite"

TMPDIR_SUITE="$(mktemp -d "${TMPDIR:-/tmp}/suite-install.XXXXXX")" ||
	die "could not create a temporary directory"

tarball="$TMPDIR_SUITE/suite-cli.tar.gz"
fetch "$TARBALL_URL" "$tarball" ||
	die "could not download suite-cli from $TARBALL_URL"
[ -s "$tarball" ] || die "downloaded an empty archive from $TARBALL_URL"

extract_dir="$TMPDIR_SUITE/extract"
mkdir -p "$extract_dir"
tar -xzf "$tarball" -C "$extract_dir" ||
	die "could not extract the downloaded archive"

# The archive has a single top-level directory.
src_root=""
for candidate in "$extract_dir"/*; do
	if [ -d "$candidate" ] && [ -f "$candidate/package.json" ]; then
		src_root="$candidate"
		break
	fi
done
[ -n "$src_root" ] || die "the downloaded archive does not look like suite-cli"
[ -f "$src_root/bin/suite.template" ] ||
	die "the downloaded archive is missing bin/suite.template"

version="$(
	sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
		"$src_root/package.json" | head -n 1
)"
[ -n "$version" ] || die "could not read the version from the downloaded package.json"

# --- an existing install is named and announced, never clobbered silently ---
if [ -e "$dest" ]; then
	existing="$("$dest" --version 2>/dev/null || echo "unknown version")"
	if [ "$existing" = "$version" ]; then
		note "suite $version is already installed at $(pretty_path "$dest")"
		note "reinstalling the same version."
	else
		note "suite $existing is already installed at $(pretty_path "$dest")"
		note "replace it with $version? [y/N]"
		reply="$(ask)"
		case "$reply" in
		y | Y | yes | YES | Yes) : ;;
		*)
			printf '\n'
			note "keeping suite $existing. nothing changed."
			exit 0
			;;
		esac
	fi
	printf '\n'
fi

# --- stage everything, then move into place ---------------------------------
staged_lib="$TMPDIR_SUITE/lib"
mkdir -p "$staged_lib"
cp -R "$src_root/src" "$staged_lib/src" || die "could not stage the suite-cli sources"
cp "$src_root/package.json" "$staged_lib/package.json" ||
	die "could not stage package.json"

staged_bin="$TMPDIR_SUITE/suite"
sed -e "s|@SUITE_LIB_DIR@|$lib_dir|g" -e "s|@SUITE_VERSION@|$version|g" \
	"$src_root/bin/suite.template" >"$staged_bin" ||
	die "could not render the suite entrypoint"
chmod 0755 "$staged_bin" || die "could not make the suite entrypoint executable"

mkdir -p "$bin_dir" || die "could not create the install directory $bin_dir"
[ -w "$bin_dir" ] || die "$bin_dir is not writable. suite-cli never uses sudo; set XDG_BIN_HOME to a directory you own."
mkdir -p "$(dirname "$lib_dir")" || die "could not create $(dirname "$lib_dir")"

rm -rf "$lib_dir.incoming"
mv "$staged_lib" "$lib_dir.incoming" || die "could not stage the library directory"
rm -rf "$lib_dir.previous"
if [ -d "$lib_dir" ]; then
	mv "$lib_dir" "$lib_dir.previous" || die "could not move the previous install aside"
fi
mv "$lib_dir.incoming" "$lib_dir" || die "could not install the suite-cli library"
rm -rf "$lib_dir.previous"

mv "$staged_bin" "$dest" || die "could not install the suite entrypoint to $dest"

# ---------------------------------------------------------------- report ----
printf '\n'
row "suite $version" "$(pretty_path "$dest")"
row "platform" "$platform"
if on_path "$bin_dir"; then
	row "PATH" "$(pretty_path "$bin_dir") is already on PATH"
	printf '\n'
else
	row "PATH" "$(pretty_path "$bin_dir") is not on PATH"
	note "add this line to your shell profile, then reopen your shell:"
	printf '\n'
	# shellcheck disable=SC2016  # $PATH is meant to stay literal: the user
	# pastes this line into a shell profile, where it expands at that point.
	printf 'export PATH="%s:$PATH"\n' "$bin_dir"
	printf '\n'
fi
# Last line: the next command, at zero indent, alone, so it can be
# double-clicked and pasted without dragging leading whitespace.
printf 'suite init\n'
