# Token refs, version 1

A **token ref** names where a runtime token is kept. It never is the token.
This file is the one definition. Every consumer reads it and runs
[`token-ref-vectors.json`](./token-ref-vectors.json) in its own test suite:

| Consumer | Where | How it pins this spec |
| --- | --- | --- |
| suite-cli | `src/token_ref.ts` | `test/token_ref_vectors.test.ts` reads the file in place |
| claude-code-suite-channel | `src/token-ref.ts` | vendored copy, `scripts/check-token-ref-vectors.sh` diffs it against a pinned suite-cli commit |
| openclaw-suite-channel | `src/token-ref.ts` | vendored copy, same diff script, CI job `token-ref vectors` |
| core `inputs.py` (Phase 2) | core installer | adopts this file later |
| the Mac app (Swift) | suite-desktop-mac | adopts this file later; today it only ever passes a ref string to `suite` |

A change to this file or to the vectors is a change to every consumer. Bump
`spec_version` in the vectors when a vector's expectation changes, and re-pin
the vendored copies in the same release.

## Syntax

```
keychain:<item>        plus a keychain service, given separately
file:<absolute path>
```

* The scheme is **lowercase** and matched exactly. `Keychain:x` is an unknown
  scheme, not a keychain ref.
* `<item>` is non-empty and contains **no whitespace and no control
  character** (space, tab, newline, carriage return, and every other
  character below U+0020 or U+007F). An item is passed to `security` as one
  argv element; a newline in it would make the ref and the item disagree in
  every log line that prints it.
* The **service** for a keychain ref travels beside the ref, never inside it:
  `--keychain-service SVC` on the CLI, `SUITE_TOKEN_KEYCHAIN_SERVICE` in the
  Claude channel's environment, `tokenKeychainService` in an OpenClaw account.
* `<absolute path>` starts with `/`.

## Resolution

Checks run in this order, and the first failure wins:

1. **Scheme.** A string that starts with `keychain:` or `file:` is a ref.
   Any other string that starts with a scheme (`^[A-Za-z][A-Za-z0-9+.-]*:`) is
   refused, `token_ref_unknown_scheme`. Runtime tokens are url-safe base64 and
   can never contain `:`, so this refusal cannot reject a real token.
   Anything else is a **literal** (see below).
2. **Syntax.** A relative path, an empty item, or an item with whitespace or a
   control character: `token_ref_invalid`.
3. **Service.** A keychain ref with no service: `keychain_service_missing`.
4. **Platform.** A keychain ref anywhere but macOS:
   `keychain_unsupported_platform`.
5. **File, by stat, before any read.** Missing: `token_file_missing`. A
   symlink or anything that is not a regular file: `token_file_not_regular`.
   Owned by another uid: `token_file_foreign_owner`. Any mode other than
   `0600` or `0400`: `token_file_mode`. The resolver never chmods a file.
6. **Read.** A file's content, with ONE trailing `\n` or `\r\n` removed. Empty:
   `token_file_empty`.

   A keychain item is read with exactly this argv, no shell:

   ```
   /usr/bin/security find-generic-password -s <service> -a <item> -w
   ```

   The path is absolute: a `security` earlier on `PATH` must not be able to
   answer for the keychain. Tests reach a fake through an injected seam, never
   through `PATH`. The value arrives on the child's stdout, into memory, with
   one trailing newline removed. A non-zero exit or an empty value:
   `keychain_unavailable` (exit 44 is "no such item"; exit 36 / -25308 is "the
   keychain is locked, or user interaction is not allowed", which is what a
   non-GUI session such as ssh gets for the login keychain).

## Literals

A string with no scheme is a literal token.

* A **ref-only consumer** refuses it, `literal_token_refused`. suite-cli is one:
  `--token-ref` takes a ref, and `--token`, `--token=` and a token on stdin are
  refused too, because argv is world-readable through `ps`.
* A **legacy consumer** may accept it as a deprecated literal, so a machine set
  up before refs existed keeps working. Both channel plugins are legacy
  consumers: `SUITE_TOKEN=<literal>` and an OpenClaw `token: "<literal>"` still
  work.

The vector `literal_value` has `outcome: "literal"`: a ref-only consumer must
refuse it with that code, and a legacy consumer must pass the value through
unchanged.

## What may be printed

A refusal or a log line names the **ref, the item, the service, the path and
the mode**. It never carries a resolved value, and it never repeats a string
that was refused as a literal (that string is the case where it is a secret).
Each vector's `expect.names` lists strings the message must contain; every
consumer also asserts the message does not contain `{value}`.

## Vectors

[`token-ref-vectors.json`](./token-ref-vectors.json). Each vector has:

* `ref`, `keychain_service` (or null) and `platform` (`darwin` or `linux`, which
  the consumer injects rather than reads);
* optionally `file` (`kind`: `regular`, `symlink` or `absent`; `mode`; `owner`:
  `caller` or `other`; `content`) and `security` (what a fake `security`
  answers: `exit`, `stdout`);
* `expect`: `outcome` (`resolved`, `refused` or `literal`), `kind` (`file`,
  `keychain`, `literal` or `unknown`), and then `value`, `code`, `names` and
  `security_args` as they apply.

`{dir}` is a fresh temp directory and `{value}` a fresh random value, both per
vector. A test that iterates the vectors must fail when the file has no vectors
(anti-vacuity) and when it meets an `outcome` it does not know.
