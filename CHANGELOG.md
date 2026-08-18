# Changelog

Notable changes to the `suite` CLI. Newest first.

The version in `package.json` is the single source of truth — `suite --version`,
the POSIX launcher and `install.sh`'s banner all read it. **Bump it in the same
PR as the change**, so that an installed CLI's version answers the only question
that matters in the field: is this one newer than what I had?

Minor for a new capability or a changed default; patch for a fix that changes no
behaviour anyone was relying on.

## 0.2.0

- **`suite init` seeds a starting `CLAUDE.md`** for new Suite agents — how a
  runtime is expected to behave on the platform, distilled from the briefs
  already in use. An existing file is never overwritten; a re-run reports
  `present, left alone`. The template is static and carries no identifiers.
- **Sessions are created with tmux mouse mode on**, scoped to the session and
  never `-g`. Without it, tmux turns a wheel event inside a full-screen app into
  arrow keys, so scrolling an agent walks its input history instead of its
  scrollback. New sessions only — reattaching never re-configures a session you
  are already working in. Note mouse mode also routes click-drag to tmux's
  selection, so a native selection needs the terminal's override modifier
  (Option on macOS).
- `--session` is wired through, so the flag the README documents exists.

## 0.1.0

First tagged version: `init`, `claude`, `doctor`, `status`, `update`, the POSIX
launcher and `install.sh`.
