/**
 * Single source of truth for the CLI version at runtime.
 *
 * install.sh reads the same value out of package.json when it renders the
 * entrypoint, so `suite --version` answers identically whether it is served by
 * the POSIX launcher (no bun required) or by this module.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version: string }).version;
