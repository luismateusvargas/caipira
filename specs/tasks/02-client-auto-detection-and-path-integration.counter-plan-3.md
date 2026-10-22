# Client auto-detection and PATH integration — counter-plan 3

Original task spec: [02-client-auto-detection-and-path-integration.md](02-client-auto-detection-and-path-integration.md)
Reviewed task: [Counter-plan 2, Q1–Q3](02-client-auto-detection-and-path-integration.counter-plan-2.md)
Review evidence: independent review, 2026-10-22 (probes below).
Status: ready

Reviewed baseline: `076bf3f37dae91fc6c2828e5711abf128f25ba65`.
Reviewed completion: `504fb70e9ee533bbc4e6e3038c011058d4583fca`.

Counter-plan 2 works on the main path:
- A fresh bash started with only `HOME` and a minimal PATH finds `~/.local/bin/caipira` and runs `caipira status`.
- Repeated installs keep one block.
- The Windows script matches the specified contract.
- All nine suites pass (958 checks, 0 failures).

Startup files are user-owned, though, and three common layouts are damaged.

## Confirmed failures

**S1 (medium; Q1/Q3): a dotfiles-managed startup file loses its symlink.**
`writeTextAtomic` (`install.js:186-197`) renames a temporary file over the path itself. `registerPath` (`install.js:466-475`) and `unregisterPath` (`install.js:494-497`) use it for startup files.
- Trigger: `~/.bashrc -> dotfiles/bashrc`, `SHELL=/bin/bash`, `PATH=/usr/bin:/bin`, then `install` followed by `uninstall`.
- Observed: after install, `~/.bashrc` is a **regular file** and `dotfiles/bashrc` has no block. After uninstall it is still a regular file.
- Impact: stow, chezmoi and similar setups stop tracking the user's shell file. With home-manager, whose symlinks point into the read-only Nix store, the next switch reports a conflicting file.

**S2 (medium; Q1 on macOS bash): creating `~/.bash_profile` stops bash from reading `~/.profile`.**
`shellStartupFiles()` (`install.js:443-446`) always writes `~/.bash_profile` on darwin. A bash login shell reads only the first file it finds among `~/.bash_profile`, `~/.bash_login` and `~/.profile`.
- Trigger: run `registerPath()` with `process.platform = 'darwin'`, `SHELL=/bin/bash`, and an existing `~/.profile` containing `export HOMEBREW_READY=1`.
- Observed: install creates `~/.bash_profile`. `bash -lc 'echo $HOMEBREW_READY'` (same lookup order as macOS) prints `1` before install and an empty line after.
- Impact: every setting in the user's `~/.profile` stops loading in Terminal. Because of S3, the empty `~/.bash_profile` left by uninstall keeps blocking it.

**S3 (low; acceptance check 4 of counter-plan 2): uninstall leaves behind startup files that install created.**
`unregisterPath` (`install.js:494-496`) deletes a file only when it is the fish file.
- Trigger: a fake `HOME` with no `~/.bashrc`, then `install` and `uninstall`.
- Observed: install creates `~/.bashrc`, and after uninstall it remains as a 0-byte file. Counter-plan 2 requires uninstall to return each startup file to its pre-install state, which here means absent.

## Surgical corrections

**T1 → S1.** For startup files only, follow existing symlinks to the real file.
- Atomically replace the **resolved target**, with the temporary file in the target's own directory, so the link is kept. Keep the optional `.caipira-backup` beside the path in `HOME` rather than inside the dotfiles directory.
- If the resolved target cannot be written (for example `EACCES`, `EPERM` or `EROFS`), change nothing.
  - On install: keep the launcher, warn with the manual `export PATH="$HOME/.local/bin:$PATH"` line, and let install succeed.
  - On uninstall: warn and continue.
- Client configuration writes are unchanged.

**T2 → S2.** On darwin with bash, pick the login file bash will actually read: the first existing file among `~/.bash_profile`, `~/.bash_login` and `~/.profile`. Create `~/.bash_profile` only when none of them exists.
- Keep `~/.bashrc` in the bash set.
- Add `~/.bash_login` to the files uninstall scans.
- Linux bash, zsh, fish and the default `.profile` choice are unchanged.

**T3 → S3.** In `unregisterPath`, delete any startup file that is empty once Caipira's marked blocks are removed, not only the fish file. Files that still have other content are rewritten byte for byte, as now.

Keep the markers, block text, idempotence, CRLF and final-newline handling, permission preservation, the Windows adapter and every client-configuration behavior unchanged.

## Acceptance and verification

1. **T1, with real bash and a fake `HOME`.**
   - With `~/.bashrc` symlinked to `dotfiles/bashrc`: install keeps the symlink; the target gains exactly one block with its other bytes unchanged; a new `bash -ic 'command -v caipira && caipira status'` succeeds; uninstall returns the target byte for byte and keeps the link.
   - With an unwritable target: install exits 0, the link and target are unchanged, the launcher exists, and the warning shows the manual line. Uninstall also leaves them unchanged.
2. **T2, using the darwin platform override.**
   - With only `~/.profile`: the block goes into `~/.profile`, no `~/.bash_profile` is created, and `bash -lc` keeps the user's variable and resolves `caipira`.
   - With only `~/.bash_login`, it receives the block.
   - With none of the three files, `~/.bash_profile` is created.
   - Uninstall returns each case to its pre-install state.
3. **T3.** Starting with no `~/.bashrc`, install then uninstall leaves no `~/.bashrc`. The cases with existing content, CRLF and a missing final newline still come back byte for byte.
4. Run the full suite and `sh -n caipira.sh`:

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Every startup-file check must use a fake `HOME`. Completion means S1–S3 are fixed and these checks pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, release, bump versions, or add co-author trailers.

## Blockers

- **Verification only (carried over from counter-plan 2, check 5):** the native Windows check needs a Windows machine. That check is: a new Start-menu `cmd` finds `caipira` after install without a sign-out, and stops finding it after uninstall. Without one, approval needs the user to accept contract-level Windows verification.
