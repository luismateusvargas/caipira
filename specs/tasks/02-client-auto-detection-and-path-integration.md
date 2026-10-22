# Client auto-detection, risk-acknowledged client overrides, and global PATH integration

Status: ready
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
