# Caipira — simple project spec

This is the permanent project spec. Plan each change as a task spec under `specs/tasks/` that links here. Task specs and their counter-plans are removed when their release ships; this file stays and is updated when a release changes a rule, boundary, or check below.

## Purpose

Caipira is a local-first, zero-daemon memory and code-intelligence layer shared by AI coding agents (**Claude Code**, **Codex**, **Antigravity**) and the developers who use them. One install serves every detected client on the machine. It provides:

1. **Standing facts (`facts.js`).** Verbatim workspace facts (`decision`, `constraint`, `gotcha`, `preference`, `status`) anchored to files, line ranges, and AST symbols. Staleness checks go through `stat`, then `sha256`, then the symbol `signature_hash`, so non-breaking edits and reverts heal themselves. Recall is ranked by trust (relevance × freshness) and fused across workspaces with Reciprocal Rank Fusion.
2. **Episodic memory (`store.js`).** Append-only captures from lifecycle hooks, compressed prose, FTS5 BM25 plus 384-dimensional local MiniLM-L6-v2 embeddings, and deterministic session digests.
3. **Polyglot AST engine (`rust/caipira-ast` + `ast.js`).** A standalone Rust tree-sitter indexer covering JavaScript, TypeScript, JSX/TSX, Vue SFC, Python, Rust, Go, and C/C++. It records structured parameters, return types, docstrings, and call/import/type/inheritance edges in the workspace database. Node queries that database in-process.
4. **Prompt injection (`inject.js`).** At session start it injects the workspace symbol map and standing facts once. Later prompt turns inject only facts that match the prompt, or nothing.
5. **Explorer (`caipira explore`).** A local React 19 + TypeScript + Canvas workbench served by `explore-server.js`. It offers graph views, a symbol inspector, a Knowledge Board for editing facts, and omni-search.
6. **Zero-prerequisite distribution.** `npm i -g @luismateusvargas/caipira` followed by `caipira install` provisions everything else: the pinned Node runtime, native SQLite, the AST binary, the UI, and the model.

Outside scope: cloud sync, remote or paid LLM calls, multi-tenant or external vector databases, background daemons, Docker as a runtime requirement, and any automatic modification of user source code. Linux musl arm64, glibc older than 2.28, and other hosts with no checksum-pinned Node build are refused until users request them.

## Runtime and files

- **Runtime / target sites.**
  - Every Caipira process (hooks, MCP, explorer, CLI commands) runs on **Node 22.23.4**, which `caipira install` provisions under `<CAIPIRA_HOME>/node22/node-v22.23.4-<target>/`. The host Node (`engines.node >=20`) only bootstraps the installer. `runtime.js` holds `NODE_VERSION` and the archive table with SHA-256 checksums.
  - Supported runtime targets: Linux glibc 2.28+ x64/arm64, Linux musl x64, macOS x64/arm64, and Windows x64/arm64. Official archives come from `https://nodejs.org/dist/v22.23.4/` and the musl archive from `https://unofficial-builds.nodejs.org/download/release/v22.23.4/`.
  - Prebuilt `caipira-ast` assets: `linux-x64` and `linux-arm64` (static musl, built with `cross`), `darwin-arm64`, `darwin-x64`, and `win32-x64` (`runtime.js::platformBinaryName`). Rust edition 2024 with LTO; `rusqlite` is bundled. Other hosts run without the AST index.
  - The prebuilt UI in `explore-ui/dist/` is served at `http://127.0.0.1:4777` by default.
  - Verification level: Linux is verified end to end. macOS, Windows, and the release workflow are checked at contract level only.
- **Entry points.**
  - `bin/caipira-cli.js` — global npm bin. It runs the package's `install.js` for `install` only. Every other command runs `<CAIPIRA_HOME>/install.js` on the deployed Node 22, and exits 1 with "run caipira install first" when there is no deployment yet.
  - `install.js` — `install [--clients <list>] [--accept-risk]`, `uninstall`, `doctor`, `status`, `logs [--limit N] [--clear]`, `prune [--apply]`, `mode <lite|full|ultra>`, `explore`. From a source checkout, run `node bin/caipira-cli.js install`.
  - `caipira.sh` / `caipira.cmd` — deployment launchers (also linked as `~/.local/bin/caipira` on POSIX). They only use the bundled Node 22.23.4 and exit 1 when it is missing; there is no fallback to Node on `PATH`.
  - `runtime.js` — dependency-free bootstrap: archive selection, checksum-verified provisioning, transactional dependency install, SQLite validation in a fresh process, and removal of superseded runtimes.
  - `mcp.js` — stdio MCP server exposing 11 tools: `search`, `get_observations`, `list_sessions`, `timeline`, `record_fact`, `search_facts`, `update_fact`, `check_drift`, `workspace_symbols`, `inspect_symbol`, `list_workspaces`. It reads its version from `package.json`.
  - `hooks/universal-hook.js` — fail-open lifecycle adapter. It handles `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` for Claude Code; Codex also gets `SessionEnd`; Antigravity gets `PreInvocation`, `PostToolUse`, `PostInvocation` and `Stop`.
  - `workspace.js` (workspace roots, `master.db` registry), `migrate.js` (master v1, workspace v1–v6), `store.js`, `facts.js`, `inject.js`, `compress.js`, `ast.js`, `errors.js`, `explore-server.js`.
- **Dependencies.**
  - The root npm package declares **no** runtime dependencies, so `npm i -g` builds nothing; npm 12 blocks dependency install scripts.
  - The runtime dependencies (`runtime/package.json` + `runtime/package-lock.json`) are `better-sqlite3` 12.9.0 (pinned; WAL + FTS5) and `@xenova/transformers` ^2.17.2. They are installed into `<CAIPIRA_HOME>/node_modules` by the bundled npm 10.9.9 (`npm ci --omit=dev`).
  - Rust (`rust/caipira-ast/Cargo.toml`): `clap`, `derive_setters`, `hex`, `ignore`, `rayon`, `rusqlite` (bundled), `serde`, `serde_json`, `sha2`, `thiserror`, `tree-sitter` 0.26, plus grammars for `cpp`, `go`, `javascript`, `python`, `rust`, and `typescript`.
  - Frontend (`explore-ui/package.json`, exact pins): `react`/`react-dom` 19.2.9, `lucide-react`, `zod`; dev: `typescript`, `vite`, `vitest`, Testing Library, `jsdom`.
  - Model: `Xenova/all-MiniLM-L6-v2` quantized ONNX, pinned revision `da5f6eac91a9596269707e15ec694e50e25a0d14`. The release workflow downloads it, checks its SHA-256, and packages it.

## Behavior and boundaries

- **Inputs.**
  - Hook JSON on stdin from the three clients.
  - MCP JSON-RPC 2.0 on stdin.
  - Workspace source files, respecting `.gitignore` and `.ignore`. A `.caipira-workspace` marker overrides the VCS root.
  - Explorer HTTP requests to `/api/*`, accepted only from same-origin loopback.
- **Outputs.**
  - Hook acknowledgements and injections on stdout: `hookSpecificOutput.additionalContext` or the client's plain acknowledgement, which is `{"continue":true}` for Claude Code and `{}` for Codex and Antigravity.
  - MCP responses on stdout.
  - Installer and CLI reports on stdout as `[ok]`, `[warn]`, `[skip]` and `[FAIL]` lines.
- **Stored data.**
  - `<CAIPIRA_HOME>` defaults to `~/.caipira`.
  - Databases: `database/master.db` and one `<workspace>.db` per workspace.
  - Logs: `logs/errors.jsonl` (rotates at 2 MB, one `.1` backup) and, with `CAIPIRA_DEBUG=1`, `logs/mcp_traffic.log` (rotates at 5 MB).
  - Deployment state: `.caipira-clients.json` records the selected clients and `.caipira-startup-files.json` the shell startup files Caipira owns.
  - The deployed code, `node22/`, `node_modules/`, `models/`, `bin/caipira-ast`, and `explore-ui/dist/`.
  - Uninstall removes registrations and leaves `database/` untouched.
  - `prune --apply` removes registry rows whose root is no longer found, and moves their databases and any unclaimed `.db` files into `database/archive/<timestamp>/`. `doctor` reports such rows as a warning, not a failure.
- **Writes outside `CAIPIRA_HOME` (installer only).**
  - Client configuration for selected clients: `~/.claude.json`, `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`, `~/.gemini/config/hooks.json`. Each write is atomic and first saves a `.caipira-backup` copy.
  - The POSIX launcher `~/.local/bin/caipira`, plus one marked PATH block in the shell startup file when `~/.local/bin` is not on PATH.
  - On Windows, the User `PATH` in `HKCU\Environment`, followed by a `WM_SETTINGCHANGE` broadcast.
  - Hooks, MCP, and the explorer write only inside `CAIPIRA_HOME`, and nothing in Caipira modifies user source files.
- **Network.**
  - Only `install` uses the network: it downloads the Node archive and installs the locked runtime dependencies from the npm registry.
  - An intact runtime and a byte-identical lockfile with a working SQLite are reused offline.
  - At runtime, embedding loads only local models (`allowRemoteModels = false`), and the explorer binds to loopback by default.
- **Client selection and consent.**
  - By default, install registers only the clients it detects (`~/.claude/` or `~/.claude.json`; `~/.codex/` or `config.toml`; `~/.gemini/` or `~/.gemini/config`).
  - `--clients` restricts registration to a list (aliases `claude` and `agy`, or `all`).
  - Selecting an undetected client requires `--accept-risk` or one interactive `[y/N]` confirmation before any write. Without it, install exits 1.
  - `doctor` checks only the recorded selection and reports other clients as not selected, never as failures.
- **Explorer security.** The explorer checks the `Host` header against DNS rebinding, requires same-origin `application/json` for writes, sends a strict CSP, and confines workspace paths, including through symlinks.
- **Privacy.** `<private>…</private>` blocks are stripped before storing observations or summaries and before any log write. Common credential formats are also redacted in logs, including bearer tokens, `sk-`/`ghp_`/`xox`/`AKIA` keys, JWTs, and URL userinfo.

## Constitution

1. **Fail-open hooks.** `hooks/universal-hook.js` must never crash or block the host agent. Malformed input, native load failures (missing module, `ERR_DLOPEN_FAILED`, ABI mismatch), stdin errors, uncaught exceptions, unhandled rejections, and database contention are journaled. The hook then writes exactly one valid client acknowledgement and exits 0, and unknown events get the plain acknowledgement.
2. **Zero daemons.** Caipira runs only over stdio and in-process SQLite WAL. It uses no background services, Docker, or external vector stores at runtime.
3. **Three-tier AST gating.** Every workspace AST sync gates on `(size, mtime_ms)` first, `sha256` second, and a tree-sitter parse third.
4. **Cache-safe injection.** The symbol map and standing facts are injected once at session start. Later turns inject only prompt-matched facts or nothing, so client prompt-prefix caches survive.
5. **Clean stdio.** stdout carries only client protocol output, plus CLI reports for the CLI. Diagnostics go to stderr or `errors.jsonl`.
6. **Verbatim facts.** Facts are canonical records and are never compressed or rewritten.
7. **One pinned runtime.** Every Caipira process runs on the deployment's checksum-verified Node `runtime.js::NODE_VERSION`. Registrations and launchers name `<CAIPIRA_HOME>/node22/<release>/…/node` and never the host interpreter or a checkout path. Every copy of the pin must match `runtime.js`: `install.js`, `bin/caipira-cli.js`, `caipira.sh`, `caipira.cmd`, `README.md`, and `.github/workflows/release.yml`. `test/test-runtime.js` enforces this.
8. **Dependency-free bootstrap.** The root package has no runtime dependencies. No step of the install path may load a module that needs runtime dependencies from the package or checkout before they exist in the deployment; `runtime.js` and `install.js` up to provisioning use only built-ins.
9. **Consent and writes.** Client selection and consent come before any filesystem write. Runtime and dependency upgrades are staged and promoted by rename, and they keep or restore the previous copy on failure. A failed rollback keeps the recovery files and reports where they are. Superseded Node releases are removed only after a successful install.
10. **Optional assets never block install.** A missing AST binary, UI bundle, or model produces a warning and keeps any deployed copy. It never prevents client registration.
11. **Single release version.** `package.json`, `package-lock.json`, `runtime/package.json`, and `runtime/package-lock.json` always carry the same version, and a release tag `vX.Y.Z` must equal it. `test/test-runtime.js` checks the runtime manifest and lockfile against the root version. The release workflow rejects a tag that differs from either `package.json`.
12. **Never delete memory.** No command deletes workspace databases, facts, or observations. A moved, renamed, or unmounted project is indistinguishable from a deleted one, so cleanup archives files instead of removing them, and only the user deletes the archive. Housekeeping findings in `doctor` are warnings, not failures. (User decision, 2026-10-22.)

## Logging policy

There is no shared level-based logger. The levels map onto the existing surfaces:

- **ERROR** — `errors.js::logError` appends one JSON line to `<CAIPIRA_HOME>/logs/errors.jsonl` for each failed operation or degraded fallback. Its components are `hook`, `mcp`, `ast`, `explore`, and `install`.
  - Each record carries `id`, `ts`, `component`, `operation`, `client`, `error {name, code, message, stack}`, `env {caipiraVersion, nodeVersion, abi, platform, arch, execPath}`, and a sanitized `repro` command with a synthetic payload.
  - Writes are synchronous so a crash is still captured. Repeats of the same error (and the cause of a translated error) are recorded once.
  - Installer and CLI failures also print `[FAIL]` and exit 1.
- **WARNING** — `[warn]` CLI lines for recoverable conditions: optional assets missing, cargo absent, PATH startup files unwritable, a failed Windows broadcast, an unremovable superseded runtime, or non-empty error logs in `doctor`. Runtime warnings go to stderr, for example explorer evidence that could not be re-read.
- **INFO** — `[ok]` and `[skip]` CLI lines for install, doctor, and uninstall outcomes, plus `status` counts. Hooks and MCP emit no INFO logs, which keeps stdout clean.
- **DEBUG** — `CAIPIRA_DEBUG=1` enables `<private>`-redacted MCP JSON-RPC traffic logging to `logs/mcp_traffic.log`. It is off by default and meant only for troubleshooting.
- **Sensitive data.** Never log raw hook payloads, prompt text, or credentials. `<private>` blocks and credential patterns are redacted before writing, and reproduction commands use synthetic payloads.
- **Inspection.** `caipira logs` prints recent entries with their reproduction commands and works even when native SQLite cannot load. `doctor` and `status` report retained error counts across both journal files.
- **Known gaps (planning work, not current behavior).**
  - DEBUG tracing covers only MCP traffic. Hooks, the AST bridge, the installer, and the explorer have no opt-in debug trace.
  - WARNING-level runtime conditions go to stderr only and are not journaled.

## Checks

Gate every change on these, run from the repository root:

```sh
# Runtime dependencies for the Node suites (same as CI), installed with the pinned Node 22.23.4 on PATH:
npm --prefix runtime ci --omit=dev --no-audit --no-fund

# Node suites (errors, workspace, facts, inject, mcp, hook, runtime, install, ast, explore) — expect 0 failures, 0 skips on 22.23.4:
TMPDIR=/var/tmp NODE_PATH="$PWD/runtime/node_modules" node test/run-all.js

# Rust engine:
cargo test --manifest-path rust/caipira-ast/Cargo.toml
cargo clippy --manifest-path rust/caipira-ast/Cargo.toml -- -D warnings

# Explorer UI:
npm --prefix explore-ui run typecheck && npm --prefix explore-ui test && npm --prefix explore-ui run build

# Hygiene:
sh -n caipira.sh && git diff --check
```

- **Test safety.**
  - Locally, run any suite or probe that starts an installer inside a capped scope, for example `systemd-run --user --scope -p TasksMax=768 -p MemoryMax=6G -p MemorySwapMax=0 …`.
  - Never fake the deployed Node with a shell wrapper at a path that `install()` provisions. `install()` re-executes whenever the interpreter differs, and its `CAIPIRA_REEXEC_GUARD` stops after one child.
  - Launcher checks run only when the suite runs on Node 22.23.4; on other versions they print visible skips.
  - `TMPDIR=/var/tmp` keeps temporary workspaces away from a stray `/tmp/.git`.
- **Release-only checks.**
  - Run before tagging when the install path, packaging, or AST build changes.
  - Static Linux AST build: `RUSTFLAGS="-C target-feature=+crt-static" cross build --locked --release --manifest-path rust/caipira-ast/Cargo.toml --target x86_64-unknown-linux-musl`. With rootless Docker, add `CROSS_ROOTLESS_CONTAINER_ENGINE=1`. Then confirm that `readelf` shows no `INTERP` or `NEEDED` entries.
  - Packed tarball: install a staged tarball (with UI, model, and a host AST binary) with `npm i -g` under a fake `HOME` and npm prefix, using `env -i`. `caipira install` must exit 0, registrations must name `<home>/.caipira/node22/node-v22.23.4-<target>/bin/node`, and the registered hook must exit 0 with no `node` on `PATH`.
  - Workflow lint: run actionlint 1.7.12 or newer; older releases do not know the `macos-15-intel` label.
- **Release.**
  - Set the version in the four manifests (rule 11), commit, then push an annotated `vX.Y.Z` tag.
  - `.github/workflows/release.yml` then works through these jobs in order:
    1. Checks that the tag matches both manifests.
    2. Builds and tests the five AST targets and runs the Node suite on Node 22.23.4.
    3. Packs the tarball with the UI and checksum-verified model.
    4. Publishes that tarball to npm through trusted publishing (OIDC, `id-token: write`, npm 11.21.1 in that job only), with automatic provenance and no stored token. If that version is already on npm with the same integrity, the job skips publishing; a different tarball under the same version fails the job.
    5. Creates the GitHub release from the tarball, the AST binaries, and `SHA256SUMS`, using the tag message as the notes.
  - **First release only.** npm accepts a trusted publisher only for an existing package. Publish the run's `release` tarball once by hand with `npm publish <tgz> --access public` (2FA). Then run `npm trust github @luismateusvargas/caipira --file release.yml --repo luismateusvargas/caipira --allow-publish`, and re-run the failed jobs.
  - `package.json` `repository.url` must stay `git+https://github.com/luismateusvargas/caipira.git`; trusted publishing requires it to match the repository.
- **Manual.** After a real install, `caipira doctor` should report no failures, and `caipira explore --no-open` should serve the invoking directory's workspace.

## Evidence and unknowns

- **Verified paths (2026-10-22):** `runtime.js`, `install.js`, `bin/caipira-cli.js`, `caipira.sh`, `caipira.cmd`, `hooks/universal-hook.js`, `mcp.js`, `errors.js`, `store.js`, `facts.js`, `inject.js`, `ast.js`, `workspace.js`, `migrate.js`, `explore-server.js`, `explore-ui/`, `rust/caipira-ast/`, `runtime/package.json`, `.github/workflows/release.yml`, `test/`.
- **Verification at release v2.2.0 (Linux x64, 2026-10-22).**
  - Node suites: 1,081 passed, 0 failed, 0 skipped on Node 22.23.4.
  - Rust: 53 tests passed; clippy is clean.
  - UI: typecheck passed and 44 tests passed.
  - Static musl `linux-x64` AST built with `cross` 0.2.5 (static-pie, no `INTERP`/`NEEDED`). `test/test-ast.js` passed 141/0 against it.
  - Packed-tarball installs passed under Node 26/npm 12, Node 24/npm 11 and 12, and Node 22.20.0/npm 10.
  - The release workflow passed actionlint 1.7.12, and its packaging and notes steps were dry-run locally.
- **Sources (accessed 2026-10-22).**
  - Node 22.23.4 `SHASUMS256.txt` on nodejs.org and unofficial-builds.nodejs.org, for the checksums in `runtime.js`.
  - `better-sqlite3` v12.9.0 release assets, which include Node 22 (ABI 127) prebuilds for linux x64/arm64, linuxmusl x64/arm64, darwin x64/arm64 and win32 x64/arm64. v12.10.0 dropped Node 20.
  - GitHub-hosted runner labels (`macos-15` arm64, `macos-15-intel` x64).
  - npm `package.json` `bin`/`files` documentation.
- **Unknowns and open decisions.**
  - macOS, Windows, and Linux arm64 have not been executed natively. The release workflow has not yet run on GitHub, and its OIDC publish path has not been exercised.
  - npm no longer accepts direct publishing with tokens that bypass 2FA: such a token returned 401 for the user on 2026-10-22. npm is targeting January 2027 for removing that path entirely. Trusted publishing needs npm 11.5.1+ and Node 22.14.0+, and the publish job installs npm 11.21.1 because Node 22.23.4 ships npm 10.9.9. `npm trust` needs npm 11.15.0+, account 2FA, and an existing package. Sources: [trusted publishers](https://docs.npmjs.com/trusted-publishers), the npm 12.2.0 `npm-trust` command docs, and the [stage-only token changelog](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation), all accessed 2026-10-22.
  - Node 22 maintenance ends in April 2027. Moving the pin means changing `NODE_VERSION`, the checksum table, and the launchers. `better-sqlite3` 12.9.0 already ships Node 24 prebuilds.
  - The user has not said how constitution rules may be revised. Until they do, treat every rule change as their decision and record it here.
  - Whether to add opt-in DEBUG tracing beyond MCP traffic (see the logging gaps) is not decided.
