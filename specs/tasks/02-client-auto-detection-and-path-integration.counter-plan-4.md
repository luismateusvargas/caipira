# Client auto-detection and PATH integration — counter-plan 4

Original task spec: [02-client-auto-detection-and-path-integration.md](02-client-auto-detection-and-path-integration.md)
Reviewed task: [Counter-plan 3, T1–T3](02-client-auto-detection-and-path-integration.counter-plan-3.md)
Review evidence: independent review, 2026-10-22 (probes below).
Status: ready

Reviewed baseline: `af97713ac8456279da3369b5f6f952977b10ead8`.
Reviewed completion: `abce83dad1a163c2fc55dc54a4005761827e217a`.

Counter-plan 3 fixes S1–S3:
- A symlinked `~/.bashrc` keeps its link. The dotfiles target gains one block, a new `bash -ic` finds and runs `caipira status`, and uninstall restores the target byte for byte.
- On macOS bash, `~/.profile` and `~/.bash_login` are no longer shadowed.
- A `~/.bashrc` that install created is gone after uninstall.
- All nine suites pass (983 checks, 0 failures). `git diff --check` and `sh -n caipira.sh` are clean, and neither commit has a co-author trailer.

The new startup-file writer added two failures in less common layouts. A third comes from counter-plan 3's T3 rule, which was worded too broadly.

## Confirmed failures

**V1 (medium; T1 regression): a dangling startup symlink aborts the whole install before any client is registered.**
`writeStartupFile` resolves links with `fs.realpathSync(file)` (`install.js:459`). For a dangling link that throws `ENOENT`, and the catch in `registerPath` (`install.js:512`) rethrows everything except `EACCES`/`EPERM`/`EROFS`. `registerPath()` runs before every client registration (`install.js:1062`).
- Trigger: a fake `HOME` with `.claude/`, `~/.bashrc -> dotfiles-moved/bashrc` (target missing, as after moving a stow or chezmoi repo), and `PATH=/usr/bin:/bin`. Then run `install`.
- Observed: `[FAIL] install — ENOENT: no such file or directory, stat '<home>/.bashrc'` and exit 1. The launcher is written, but `.claude.json` and `.claude/settings.json` are never created, and the error is journaled. With the same home, `504fb70` exits 0.
- The same path with a looping link (`~/.bashrc -> .bashrc`) fails with `ELOOP` on both install and uninstall. That failure goes back to counter-plan 2 (`readStartupFile`, `install.js:442`), and the new catches still rethrow it.

**V2 (low; T1 regression): a leftover temporary file makes every later install fail.**
`writeStartupFile` creates `<target>.caipira-tmp` with exclusive mode `'wx'` (`install.js:468`), before the `try` whose `finally` would remove it. A temporary file left by an interrupted install (Ctrl-C or SIGKILL between create and rename) therefore causes `EEXIST` on every later run, and `EEXIST` is not a recoverable code.
- Trigger: `~/.bashrc` with user content and a leftover `~/.bashrc.caipira-tmp`. Then run `install` twice.
- Observed: both runs give `[FAIL] install — EEXIST: file already exists, open '<home>/.bashrc.caipira-tmp'` and exit 1, before client registration. At `504fb70` the same home exits 0, because `writeTextAtomic` overwrote the leftover file.

**V3 (low; my counter-plan 3 T3 wording conflicts with its own check 2): uninstall deletes startup files that existed, empty, before install.**
`writeStartupFile` unlinks any regular file left empty (`install.js:465`). File content cannot tell a file install created apart from a 0-byte file the user already had.
- Trigger (macOS bash, through the darwin override): an empty `~/.bash_profile` and a `~/.profile` containing `export PROFILE_ONLY=1`. Then install and uninstall.
- Observed: `bash -lc 'echo $PROFILE_ONLY'` prints an empty line before install and `1` after uninstall. `~/.bash_profile` was deleted, so bash now reads `~/.profile`, a file it did not read before.
- The same deletion happens to a pre-existing empty `~/.bashrc`, and to an empty `~/.zshrc` under `SHELL=zsh`. Users often `touch ~/.zshrc` to suppress zsh's first-run `zsh-newuser-install` prompt, which zsh documents as running when no user startup file exists. zsh is not installed here, so that effect was not executed.
- Counter-plan 2 Q3 and counter-plan 3 check 2 require uninstall to remove exactly what install added and return each case to its pre-install state.

## Surgical corrections

**W1 → V1.** Treat a startup path that cannot be resolved the same way as an unwritable target: a symlink whose target is missing (`ENOENT` from resolving it) or a link loop (`ELOOP`).
- On install: change nothing, keep the launcher, warn with the manual `export PATH="$HOME/.local/bin:$PATH"` line, and continue to client registration.
- On uninstall: a dangling link stays silent, as now. A loop warns and uninstall continues.
- Never create a missing link target or its directory.
- Define the recoverable error codes once, as a named constant used by both catches (`install.js:512` and `:541` repeat the list today).

**W2 → V2.** Before the exclusive create, remove any leftover `<target>.caipira-tmp`. `fs.rmSync(..., { force: true })` deletes a link without following it. Keep the exclusive create, the creation mode and the cleanup in `finally`.

**W3 → V3.** Uninstall deletes a startup file left empty only if install created it.
- When install creates a startup file that did not exist before (no entry at `lstat`, and the write succeeded), record its absolute path in a small JSON state file in the deployment. Name the file's path as a constant, write the file atomically, and never record a path twice.
- On uninstall, after removing the blocks:
  - delete an empty regular file only if its path is recorded, or if it is the Caipira-owned `conf.d/caipira.fish` (as now);
  - otherwise write it back as an empty file, keeping it and its mode.
- Drop each processed path from the state file, and delete the state file once it is empty.
- If the state file is missing or unreadable, treat it as an empty list, so user files are kept.
- Keep the rest of counter-plan 3 unchanged: empty symlink targets stay with their links, and every non-empty file comes back byte for byte.
- Update the README sentence "deleting regular startup files left empty" to say only files install created are deleted.

Keep the markers, block text, idempotence, CRLF and final-newline handling, file selection, permission preservation, symlink handling for resolvable links, backups, the Windows adapter and every client-configuration behavior unchanged.

## Acceptance and verification

1. **W1, with a real install, a fake `HOME` containing `.claude/`, and `PATH=/usr/bin:/bin`.**
   - With `~/.bashrc -> dotfiles-moved/bashrc` (missing target), install exits 0. The link is unchanged and still dangling, and no `dotfiles-moved` is created. The warning names `~/.bashrc` and shows the manual line. The launcher exists, and Claude Code's MCP server and hooks are registered.
   - Uninstall then exits 0 and leaves the link unchanged.
   - With `~/.bashrc -> .bashrc` (a loop), both install and uninstall exit 0, each with a warning, and both registrations are created and then removed.
2. **W2.**
   - With user content in `~/.bashrc` and a leftover `~/.bashrc.caipira-tmp`, install exits 0, the file gains exactly one block, and no `.caipira-tmp` file remains.
   - The same holds for a symlinked `~/.bashrc` with a leftover `<target>.caipira-tmp` beside its target.
3. **W3.**
   - A pre-existing 0-byte `~/.bashrc` (Linux bash), a pre-existing 0-byte `~/.zshrc` (`SHELL=zsh`, checked by content) and, through the darwin override, a pre-existing 0-byte `~/.bash_profile` with `~/.profile` content each still exist as 0-byte files with their original mode after install and uninstall. The darwin `bash -lc` prints the same empty value as before install.
   - Every case that started absent ends absent: counter-plan 3 check 3, the darwin "none exists" case, and the fish file. The state file is gone after a full uninstall.
   - With the state file deleted between install and uninstall, a created `~/.bashrc` is kept as an empty file and uninstall exits 0.
4. Run the full suite, `sh -n caipira.sh` and `git diff --check`:

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Every startup-file check must use a fake `HOME`. Completion means V1–V3 are fixed and these checks pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, release, bump versions, or add co-author trailers.

## Blockers

- None. On 2026-10-22 the user accepted contract-level verification in place of native Windows, macOS, zsh and fish runs (counter-plan 2, check 5). Approval now depends only on V1–V3 being fixed and checks 1–4 passing on Linux.
- Not blockers, recorded for later:
  - **Spec decision:** `doctor` fails a detected client that `--clients` deliberately excluded.
  - **Task 03:** npm's global `caipira` bin and `~/.local/bin/caipira` can shadow each other depending on PATH order.
