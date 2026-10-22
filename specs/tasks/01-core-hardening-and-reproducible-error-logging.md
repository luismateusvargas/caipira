# Core resilience hardening, reproducible error logging, and hash spec alignment

Status: ready
Project rules: specs/project.md
Target files: errors.js, hooks/universal-hook.js, install.js, mcp.js, README.md, test/test-hook.js, test/test-errors.js

## Outcome and boundary

Harden the lifecycle hook and MCP execution paths against native dependency crashes (such as `better-sqlite3` ABI mismatches), unhandled stream errors, and unexpected client event payloads so that Caipira strictly guarantees fail-open safety (always exiting code 0 with valid client JSON). Introduce a zero-dependency structured error journal (`errors.js` writing to `<CAIPIRA_HOME>/logs/errors.jsonl`) that captures runtime metadata and sanitized one-command reproduction hints, inspectable via `caipira logs` and surfaced in `caipira doctor`. Align `README.md` and `mcp.js` metadata with the live implementation (64-bit truncated SHA-256 signature hash and dynamic versioning).

Outside scope: Changes to the Rust AST indexing grammar, client configuration file creation (Task 02), or global npm packaging (Task 03).

## Acceptance criteria

1. **Native module load failure fail-open**:
   - When `better-sqlite3` fails to load (e.g., `ERR_DLOPEN_FAILED` or missing module), `hooks/universal-hook.js` does NOT crash at startup with exit code 1. Instead, it catches the load error, logs it to `errors.jsonl`, writes valid client acknowledgement (`{"continue":true}` for Claude Code, `{}` for Codex and Antigravity) to `stdout`, and exits code 0.
2. **Unhandled Antigravity lifecycle event safety**:
   - When an unhandled or new lifecycle event name is received with `--client antigravity`, `writeClientResult` outputs `{}` (the client acknowledgement) rather than leaking internal `{ ok: true, event, ... }` JSON.
3. **Stream and process error resilience**:
   - `process.stdin` error events or unhandled promise rejections inside the hook process are caught, recorded to `errors.jsonl`, and exit 0 with safe client fallback JSON.
4. **Structured reproducible error journal (`errors.js` + `errors.jsonl`)**:
   - Any runtime failure or degraded fallback across hooks, MCP, AST bridge, or installer appends a single JSON line to `<CAIPIRA_HOME>/logs/errors.jsonl`.
   - Each entry contains: `id`, `ts` (ISO string), `component` (`hook` | `mcp` | `ast` | `explore` | `install`), `operation`, `client`, `error` (`{ name, code, message, stack }`), `env` (`{ caipiraVersion, nodeVersion, abi, platform, arch, execPath }`), and `repro` (a sanitized shell reproduction command such as `caipira-hook --client <c> --event <e>` with payload skeleton).
   - Log files auto-rotate when exceeding 2 MB, keeping at most one `errors.jsonl.1` backup. `<private>` tags and sensitive tokens are redacted.
5. **CLI error log inspection and status reporting**:
   - `install.js` supports `caipira logs [--limit N] [--clear]`. `caipira logs` prints recent error entries in a human-readable format with one-line reproduction commands.
   - `caipira doctor` and `caipira status` report the count of recent logged errors (flagging non-zero errors as warnings in `doctor`).
6. **Documentation and version spec alignment**:
   - `README.md` updates the description of `signature_hash` from "64-bit FNV-1a" to "64-bit truncated SHA-256 (`hex::encode(&Sha256::digest(&payload)[..8])`)", matching `rust/caipira-ast/src/parser.rs`.
   - `mcp.js` reads its server version dynamically from `package.json` (replacing hardcoded `'2.0.0'`) and updates `server/discover` instructions to include facts, drift detection, and AST symbol tools.

## Implementation plan

1. **Create `errors.js`**:
   - Implement standalone logging utility with zero external dependencies.
   - Implement `logError({ component, operation, client, event, error, payload, args })`:
     - Reads `CAIPIRA_HOME` (defaulting to `~/.caipira`).
     - Ensures `<CAIPIRA_HOME>/logs/` exists.
     - Performs size-check rotation at 2 MB (`errors.jsonl` → `errors.jsonl.1`).
     - Constructs structured record with environment diagnostics and redacted reproduction command.
     - Appends entry synchronously (`appendFileSync`) so crashes are captured before process termination.
   - Implement `readErrors({ limit, clear })` for CLI queries.
2. **Harden `hooks/universal-hook.js`**:
   - Move top-level imports of `../store`, `../workspace`, `../inject`, `../facts`, and `../ast` into a lazy-loader function `loadModules()` invoked inside `main()`'s `try` block.
   - Attach `process.stdin.on('error', err => { logError(...); writeFailure(event, client); })`.
   - Add `process.on('uncaughtException', err => { logError(...); writeFailure(event, client); process.exit(0); })`.
   - Update `writeClientResult` to ensure any unrecognized event for Antigravity writes `acknowledgement('antigravity')` (`{}`).
   - Update `writeFailure` to log to `errors.js` before writing acknowledgement and exiting.
3. **Add `caipira logs` to `install.js`**:
   - Add `logs` subcommand to CLI commands table.
   - Add error count check to `doctor()` and `status()`.
4. **Update `mcp.js` and `README.md`**:
   - Replace hardcoded `'2.0.0'` in `server/discover` and `initialize` handlers with `require('./package.json').version`.
   - Correct FNV-1a reference to 64-bit truncated SHA-256 in `README.md`.
5. **Write tests in `test/test-errors.js` and extend `test/test-hook.js`**:
   - Test rotation, formatting, redaction, and reproduction output in `test-errors.js`.
   - Test synthetic module load failure (`ERR_DLOPEN_FAILED` simulation) in `test-hook.js` verifying exit code 0 and valid client output.

## Verification

- `node test/test-errors.js` — passes all rotation, formatting, environment metadata, and redaction checks.
- `node test/test-hook.js` — passes all hook resilience checks, including simulated native module failures, Antigravity unknown events, and stdin errors.
- `node test/run-all.js` — all existing and new test suites pass with 0 failures.
- Manual check: `caipira logs` prints formatted output; `caipira doctor` reports 0 errors.

## Open decisions and sources

- None. Primary source verified: `rust/caipira-ast/src/parser.rs` lines 1119–1130 for SHA-256 signature hash.
