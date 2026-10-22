# Client auto-detection and PATH integration — counter-plan 2

Original task spec: [02-client-auto-detection-and-path-integration.md](02-client-auto-detection-and-path-integration.md)
Reviewed task: [Counter-plan 1, K1–K4](02-client-auto-detection-and-path-integration.counter-plan.md)
Review evidence: independent review, 2026-10-22, plus the user's requirement decision of the same date.
Status: ready

Reviewed baseline: `956481061a7f47368da3064bfe6c7f5a3ef14a7c`.
Reviewed completion: `392dbd485cdb57520b622df8351d85bda9984e4c`.

Counter-plan 1 is verified. H1–H4 are fixed, the full suite passes (930/0), and the review found nothing new.

## Requirement change (user decision, 2026-10-22)

Criterion 4 must be **automatic**. After `caipira install`, which Task 03's `npm i -g` flow will also call, the only thing the user may need to do is open a new shell or `cmd` window. They must not edit a startup file by hand or sign out.

This replaces criterion 4's "logs a clear recommendation to add `export PATH=…`" behavior on Linux and macOS. It also tightens the Windows wording "adds … to the User PATH".

## Confirmed failures

**P1 (Linux/macOS; criterion 4 as amended): if `~/.local/bin` is not on PATH, the user has to edit a shell file by hand.**
`registerPath()` (`install.js:362-376`) writes `~/.local/bin/caipira`. When `~/.local/bin` is missing from `PATH`, it only prints `add export PATH="$HOME/.local/bin:$PATH" to your shell rc`. Nothing in `install.js` touches `.bashrc`, `.zshrc`, `.profile` or fish configuration.
- Observed: an install with `PATH=/usr/bin:/bin` printed exactly that warning and changed no startup file. A new terminal still cannot find `caipira`.
- This is the normal case on macOS, where zsh does not include `~/.local/bin`. On many Linux distributions `~/.profile` adds it only if the directory already existed at login, which means signing out and back in, not just opening a new terminal.
- It works on the review host only because `~/.local/bin` is already on PATH there.

**P2 (Windows; criterion 4 as amended, from reading the code): the PATH change is never announced to Windows.**
The PowerShell adapter (`install.js:344-358`) writes `HKCU\Environment\Path` directly through `Microsoft.Win32.Registry` and sends no `WM_SETTINGCHANGE "Environment"` broadcast. Windows only reloads the user environment for new processes after that broadcast. Until then, a `cmd` opened from the Start menu, Explorer or the taskbar keeps the old PATH until the user signs out.
- Evidence: the adapter script and its test (`test/test-install.js` §8) contain no broadcast. This is documented Windows behavior; it has not been run on a Windows machine.

## Surgical corrections

**Q1 → P1 (Linux/macOS).** Keep the `~/.local/bin/caipira` launcher. When `~/.local/bin` is not on the current `PATH`, add **one** marked, idempotent block to the startup file of the user's shell, chosen from `$SHELL`:
- bash → `~/.bashrc`, plus `~/.bash_profile` on macOS, where Terminal starts login shells;
- zsh → `~/.zshrc`;
- fish → `~/.config/fish/conf.d/caipira.fish`;
- anything else → `~/.profile`.

For POSIX shells the block is:

```sh
# >>> caipira PATH >>>
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
# <<< caipira PATH <<<
```

For fish, use the same markers around `contains -- $HOME/.local/bin $PATH; or set -gx PATH $HOME/.local/bin $PATH`.

Rules for writing it:
- Write with the existing `writeTextAtomic`; a `.caipira-backup` copy of a startup file is acceptable.
- Never change a file that already contains the start marker.
- Keep every other line of the file byte for byte.
- Replace the current warning with `[ok] PATH configured in <file> — open a new terminal`.
- When `~/.local/bin` is already on PATH, make no startup-file change, as today.
- Name every new marker and path as a constant.

**Q2 → P2 (Windows).** Keep the existing raw-value (`DoNotExpandEnvironmentNames`), `ExpandString`, case-insensitive dedupe and `Stop` behavior. After a successful `SetValue`, broadcast `WM_SETTINGCHANGE` (`0x1A`) with `lParam "Environment"` to `HWND_BROADCAST` (`0xFFFF`). Use `SendMessageTimeout` with `SMTO_ABORTIFHUNG`, declared through `Add-Type` inside the existing PowerShell script.
- Name the broadcast timeout as a constant (milliseconds), keep it within `PATH_REGISTRY_TIMEOUT_MS`, and pass it through the environment like `CAIPIRA_PATH_TARGET`.
- A failed broadcast must not undo the registry write. Report it with `[warn]` and say that signing out completes the change.
- Do not switch to `[Environment]::SetEnvironmentVariable`. It rewrites the value as `REG_SZ` and breaks `%VAR%` entries.

**Q3 → reversibility of Q1/Q2 (criterion 3).** `caipira uninstall` removes exactly what install added:
- each marked block, cutting only the text from the start marker through the end marker and keeping every other line byte for byte;
- the fish `conf.d/caipira.fish` file, only if it contains the marker;
- on Windows, the User PATH entry whose expanded value equals the deployment directory (case-insensitive), followed by the same broadcast.

Do not touch entries or files without Caipira's markers. A missing file or entry is silent, as uninstall is today.

## Acceptance and verification

1. **Q1 with real bash** (fake `HOME`, `SHELL=/bin/bash`, `PATH` without `~/.local/bin`):
   - `install` adds exactly one block to `~/.bashrc`, and a second install leaves the file unchanged.
   - A **new** `bash -ic 'command -v caipira && caipira status'`, with that `HOME` and a minimal `PATH`, resolves `~/.local/bin/caipira` and exits 0 from another directory.
   - With `~/.local/bin` already on `PATH`, no startup file is created or changed.
   - Pre-existing `~/.bashrc` content is preserved byte for byte.
2. **Q1 file selection.**
   - With `SHELL=/bin/sh`, `~/.profile` gets the block, and a new `sh -lc 'command -v caipira'` resolves it.
   - With `SHELL=/usr/bin/zsh` and `SHELL=/usr/bin/fish`, the correct file gets the correct block, checked by content (zsh and fish are not installed on the review host).
   - On macOS with bash, `~/.bash_profile` is also covered, through a platform-override fixture.
3. **Q2 contract.** The Windows adapter test confirms that the script declares `SendMessageTimeout`, sends `0x1A` / `"Environment"` to `0xFFFF` with `SMTO_ABORTIFHUNG` and the named timeout, broadcasts only after `SetValue`, and still has the raw/`ExpandString`/dedupe/`Stop` elements. A simulated broadcast failure gives a `[warn]` while the registry write stays.
4. **Q3.**
   - After an install with a block, `uninstall` returns each startup file byte for byte to its pre-install content and removes `caipira.fish`.
   - Files and PATH entries without markers are left alone.
   - The Windows removal-plus-broadcast script passes the same contract checks.
   - Uninstall on a home with nothing installed stays quiet and creates nothing.
5. **Native Windows (manual; see Blockers).** Install from a normal `cmd`, then open a new `cmd` from the Start menu. `where caipira` finds `<deployment>\caipira.cmd` and `caipira status` runs, with no sign-out. After `uninstall`, a new `cmd` no longer finds it.
6. Run the full suite after the final edit:

```sh
TMPDIR=/var/tmp NODE_PATH=~/.caipira/node_modules ~/.caipira/node22/node-v22.20.0-linux-x64/bin/node test/run-all.js
```

Also run `sh -n caipira.sh`. Every startup-file test must use a fake `HOME`; none may read or change the reviewer's real startup files or registry. Completion means P1 and P2 are fixed with Q3, and checks 1–4 and 6 pass, followed by an independent review. Follow the local baseline/completion checkpoints. Do not push, release, bump versions, or add co-author trailers.

## Blockers

- **Verification only:** check 5 needs a native Windows machine. Without one, Windows is verified at the contract level (check 3), and the approval tag waits for the user to accept that limit.
- Not blockers, recorded for later:
  - **Task 03:** after `npm i -g @luismateusvargas/caipira`, npm's global bin also provides a `caipira` command, so the two can shadow each other depending on PATH order.
  - The open decision from the first review: `doctor` fails a detected client that `--clients` deliberately excluded.
