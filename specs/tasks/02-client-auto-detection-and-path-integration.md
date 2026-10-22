# Client auto-detection, risk-acknowledged client overrides, and global PATH integration

Status: implemented — pending independent review
Project rules: specs/project.md
Target files: install.js, caipira.sh, caipira.cmd, README.md, test/test-install.js

## Outcome and boundary

Update `install.js` to detect installed AI coding clients (**Claude Code**, **Codex**, **Antigravity**) and register MCP servers and lifecycle hooks only for detected environments by default, eliminating the unconditional creation of phantom configuration directories (`~/.claude.json`, `~/.gemini/config/`). Support an explicit `--clients <list>` override with a user agreement requirement (`--accept-risk` flag in non-interactive mode or an interactive prompt) acknowledging that modifying uninstalled or custom client configurations is at the user's operational risk. Add `caipira` to the system user `PATH` across Linux, macOS, and Windows so commands like `caipira explore` work from any directory. Ensure full atomic synchronization of core runtime files into `CAIPIRA_HOME` when installing from a checkout.

Outside scope: Publishing to the npm registry (Task 03) or modifying hook protocol payloads.

## Acceptance criteria

1. **Client auto-detection by default**:
   - `caipira install` inspects the host environment before registering each client:
     - **Claude Code**: detected if `~/.claude` directory or `~/.claude.json` exists.
     - **Codex**: detected if `~/.codex` directory or `~/.codex/config.toml` exists.
     - **Antigravity**: detected if `~/.gemini` directory or `~/.gemini/config` exists.
   - For any client not detected, `caipira install` logs `[skip] <Client> not detected (use --clients <name> --accept-risk to force)` and does NOT create empty or phantom config files.
2. **Forced registration with explicit risk agreement**:
   - `caipira install --clients <list>` allows specifying any combination of `claude-code` (or `claude`), `codex`, `antigravity` (or `agy`), or `all`.
   - When `--clients` forces registration for a client not detected on the machine:
     - In non-interactive mode (or when `--accept-risk` is omitted), the installer prints an explicit disclaimer (*"Configuring hooks and MCP servers for undetected clients is done under your own account and operational responsibility. Rerun with --accept-risk to confirm."*) and exits with code 1.
     - In an interactive TTY without `--accept-risk`, it prompts `[y/N]` before proceeding.
     - With `--accept-risk`, it forces registration and creates the required configuration atomically.
3. **`caipira doctor` and `caipira uninstall` alignment**:
   - `caipira doctor` reports `[ok]` for verified detected clients, but reports `[warn] <Client> not detected — checks skipped` instead of `[FAIL]` when an unconfigured client is absent.
   - `caipira uninstall` unregisters Caipira only from detected or previously configured clients without failing or warning on missing configs.
4. **Global PATH integration across platforms**:
   - On Linux and macOS: `caipira install` ensures a `caipira` launcher executable exists in `~/.local/bin/caipira` (or `/usr/local/bin` if writable), creating `~/.local/bin` if needed. If `~/.local/bin` is not in `process.env.PATH`, it logs a clear recommendation to add `export PATH="$HOME/.local/bin:$PATH"` to the user's shell rc.
   - On Windows: `caipira install` adds `%USERPROFILE%\.caipira` to the User `PATH` environment variable (via registry `HKCU\Environment` or PowerShell `[Environment]::SetEnvironmentVariable`) if not already present.
   - Once installed, running `caipira explore` from any terminal directory launches the explorer for that current directory without requiring absolute path prefixes.
5. **Full runtime checkout synchronization**:
   - When running `caipira install` from a source checkout (`ROOT !== HOME_DIR`), all core JS runtime files (`mcp.js`, `store.js`, `facts.js`, `inject.js`, `ast.js`, `workspace.js`, `migrate.js`, `compress.js`, `errors.js`, `explore-server.js`, `hooks/universal-hook.js`), the `explore-ui/dist` bundle, and `bin/caipira-ast` are atomically copied to `<CAIPIRA_HOME>`, preventing version drift between checkouts and the live deployment.

## Implementation plan

1. **Refactor client detection in `install.js`**:
   - Define `detectClients()` returning `{ claude: boolean, codex: boolean, antigravity: boolean }`.
   - Update `registerMcpServer`, `registerHooks`, `registerCodex`, `registerAntigravity`, and `registerAntigravityHooks` to accept an `options` object controlling whether each client is enabled.
2. **Implement `--clients` and `--accept-risk` CLI arguments**:
   - Parse `--clients` (comma-separated names or `all`) and `--accept-risk`.
   - Check if any requested client is undetected; if so, verify `--accept-risk` or prompt in interactive TTY.
3. **Implement PATH registration**:
   - On POSIX (Linux/macOS): write/symlink launcher script to `~/.local/bin/caipira` pointing to `~/.caipira/caipira.sh`.
   - On Windows: check user PATH via `reg query "HKCU\Environment" /v Path` and append `%USERPROFILE%\.caipira` if missing.
4. **Implement comprehensive checkout synchronization**:
   - Extend `deployExplore()` in `install.js` into `deployRuntime()` that stages and copies all required runtime files to `~/.caipira` when invoked outside `HOME_DIR`.
5. **Update `doctor()` and `uninstall()` in `install.js`**:
   - Change hard `[FAIL]` checks for missing Claude and Antigravity configs into `[warn]` when not detected and not configured.
6. **Extend `test/test-install.js`**:
   - Test clean auto-detection on a fake home with 0, 1, or all clients installed.
   - Test `--clients` refusal without `--accept-risk` in non-interactive execution.
   - Test `--clients <list> --accept-risk` forced installation.
   - Test PATH launcher creation and runtime sync.

## Verification

- `node test/test-install.js` — passes all auto-detection, risk agreement, PATH registration, and checkout sync checks.
- `node test/run-all.js` — all suites pass with 0 failures.
- Manual test on isolated `CAIPIRA_HOME`:
  - `caipira install` on empty home skips uninstalled clients cleanly.
  - `caipira doctor` reports 0 failures.
  - `caipira explore --no-open` runs successfully from an arbitrary workspace directory.

## Open decisions and sources

- None. PATH registration targets `~/.local/bin` (XDG Base Directory / systemd user standard) on POSIX and `HKCU\Environment` on Windows.

## Implementation evidence

- Baseline checkpoint: `d28c6a39231713238c87974751af518f308e4dbe`.
- Changed paths: `install.js`, `caipira.sh`, `caipira.cmd`, `README.md`, `test/test-install.js`, and this task spec. Task 03 remains untouched and untracked.
- Default detection recognizes all six specified directory/file markers. Explicit selection accepts canonical names, aliases and `all`; unknown names and malformed arguments fail. Undetected selections require agreement before dependency, build, deployment or client configuration writes. Interactive yes/default-no responses are exercised with simulated TTY I/O.
- Registration targets the synchronized deployment. Codex registration creates a fresh config when needed, preserves user hooks/settings, quotes paths containing apostrophes, and retains the 3-second SessionEnd timeout. Doctor skips absent clients with warnings; uninstall ignores missing registrations.
- Runtime deployment stages all core files plus installer/launchers/package metadata and available UI/AST assets before promotion. Tests verify byte equality, replacement of stale files, removal of obsolete UI assets, and preservation of data/prerequisites. Injected staging and promotion failures preserve the previous deployment; a rollback failure retains recovery files and reports their location.
- POSIX launcher execution through `PATH` works from an arbitrary directory, including a deployment path containing spaces and an apostrophe. The installed Explorer starts with `--no-open --port 0`; its HTTP workspace response identifies the invoking directory. POSIX launcher uses portable symlink resolution and selects Linux/macOS and x64/arm64 bundled runtimes; the Windows launcher selects x64/arm64.
- Windows PATH adapter uses bounded PowerShell, preserves raw expandable registry entries, deduplicates expanded paths case-insensitively, and stops on registry errors. Its command/env contract is tested with simulated I/O. Windows integration fixtures intercept the registry boundary so tests cannot mutate the actual user PATH.
- Final verification with bundled Node 22: `NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js` passed all nine suites: **912 checks, 0 failures** (20/33/87/100/90/167/83/141/191). The installation suite also passed independently. `git diff --check` and `sh -n caipira.sh` passed. Sandbox subprocesses returned EPERM, so successful integration runs used approved execution outside the sandbox with temporary homes.
- Compatibility decisions: UI and AST remain optional; unavailable checkout assets retain their existing deployed copies with a warning. Node 22, native dependencies and model remain pre-provisioned; their packaging/download is Task 03. Synchronization promotes files atomically by rename with rollback across the staged set; it does not provide a simultaneous snapshot of all files to existing readers.
- Limits: verified on Linux with isolated homes and local prerequisites. Native Windows/macOS execution, real Windows registry writes, a live user installation upgrade, abrupt termination during promotion, and concurrent installers were not verified. No hook protocol payloads, release versions, publications, pushes, or approval tags changed. Independent review is pending.
