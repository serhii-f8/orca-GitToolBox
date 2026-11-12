# Merge Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve git conflicts inside the Git Toolbox panel: conflicts dialog, three-pane merge view, finish/continue/skip.

**Architecture:** A pure three-way merge module (`panel/merge.js`) builds aligned regions from base/ours/theirs and models chunk resolution; the worker (`worker/conflicts.mjs`) reads index stages, names the sides, and writes results through git objects (`hash-object --no-filters` + `update-index --cacheinfo` + `checkout-index`), so it works through the WSL `wsl.exe` path with no host file I/O. The panel adds a conflicts dialog, a full-panel merge overlay and banner actions.

**Tech Stack:** Plain ES modules, no dependencies; `node --test` with `--experimental-strip-types`; git ≥ 2.23.

**Spec:** `docs/superpowers/specs/2026-11-12-merge-conflicts-design.md`

## Global Constraints

- No runtime dependencies, no bundler; panel files are browser ES modules, worker files are Node ES modules.
- Every git call goes through `runGit` (`worker/git.mjs`); no host-side temp files.
- Paths reaching git go through `assertPaths`; revs through `assertRev`.
- Don't name other products anywhere (README, manifest, comments).
- Release as 0.4.0; README and manifest description mention conflict resolution; new screenshot `media/merge-dark.png`.

## Review Focus

1. CRLF files and files without a final newline: Apply must write back byte-identical line endings for untouched regions (merge.js test `keeps CRLF and missing final newline`; worker test `writeResolved keeps CRLF`).
2. Non-UTF-8 or binary stage content: must fall back to whole-file Yours/Theirs, never round-trip through a lossy string (worker test `binary and non-utf8 files are whole-file only`).
3. Delete/modify conflicts: Accept the deleting side removes the file; accepting the keeping side stages it (worker test `resolveSide on deleted-by-them`).
4. Background refresh while the merge view is open must not replace it (manual check in Task 5: refresh button while overlay open).
5. Rebase labels: "ours" is upstream; the header must say so (worker test `labels for rebase`).

---

### Task 1: Three-way merge model (`panel/merge.js`)

**Files:** Create `panel/merge.js`; Test `tests/merge.test.ts`

**Interfaces — Produces:**
- `splitLines(text: string): string[]`: lines keep their terminators (`"a\r\n"`, last line may lack one).
- `diffLines(a: string[], b: string[]): {aStart, aEnd, bStart, bEnd}[]`: Myers O(ND) diff hunks, half-open ranges.
- `buildRegions(base, ours, theirs: string): Region[]` where Region is `{type:'equal', lines}` or `{type:'chunk', kind:'ours'|'theirs'|'same'|'conflict', base, ours, theirs: string[]}`.
- `createMerge(regions): Merge` with state per chunk `{ours:'pending'|'taken'|'ignored'|'none', theirs:…, order:('ours'|'theirs')[], manual: string[]|null}`; `same` chunks start resolved with ours text.
- `take(m, i, side)`, `ignore(m, i, side)`, `setManual(m, i, lines)`, `applyNonConflicting(m)`, `chunkText(m, i): string[]`, `isResolved(m, i)`, `counts(m): {conflicts, changes}` (unresolved conflict chunks / unresolved one-sided chunks), `resultText(m): string`, `hasConflictMarkers(text): boolean`.

- [ ] Step 1: tests: `regions for one-sided, same and conflicting edits`; `take then take other side appends`; `ignore resolves without changing text`; `applyNonConflicting resolves only one-sided`; `keeps CRLF and missing final newline` (resultText after taking all equals expected bytes); `insertions at same base point conflict`; `hasConflictMarkers`.
- [ ] Step 2: run `npm test`, expect failures (module missing).
- [ ] Step 3: implement. Merging hunks: walk both hunk lists sorted by base start; group hunks whose base ranges overlap or touch (insertions at the same base index count as touching); each group → chunk with base range = union, each side's lines = side's text over that union mapped through its hunks.
- [ ] Step 4: `npm test` passes.

### Task 2: Worker conflict access (`worker/conflicts.mjs`)

**Files:** Create `worker/conflicts.mjs`; Modify `worker/git.mjs` (runGit `buffer: true` option returning Buffer), `worker/main.mjs` (handlers/actions); Test `tests/conflicts.test.ts` (real temp repos)

**Interfaces — Produces:**
- `conflictInfo(repo): Promise<{op: 'merge'|'rebase'|'cherry-pick'|'revert'|null, oursLabel, theirsLabel, files: {path, code, type}[]}>`. `type` from XY: UU both modified, AA both added, AU added by us, UA added by them, DU deleted by us, UD deleted by them, DD both deleted. Labels per spec Naming table; no op → "Current branch" / "Stash".
- `readConflict(repo, path): Promise<{base, ours, theirs: string|null, current: string|null, whole: false|'binary'|'large'|'structural', mode}>` — stages from `ls-files -u -z`, blobs via `cat-file blob` as Buffer; binary if NUL in first 8000 bytes or utf-8 round-trip differs; large if > 1 MiB; structural if ours or theirs missing. `current` = worktree file in index form (`hash-object -w -- path` then `cat-file blob`), null if missing.
- `writeResolved(repo, path, content)`: `hash-object -w --stdin --no-filters`, `update-index --add --cacheinfo mode,sha,path`, `checkout-index -f -- path`.
- `resolveSide(repo, paths, side: 'ours'|'theirs')`: side's stage missing → `git rm -q -f --`; else `checkout --ours|--theirs --` then `add --`.
- Actions in `main.mjs` `action()`: `resolveSide {paths, side}`, `writeResolved {path, content}`, `continue {what}` (`-c core.editor=true <what> --continue`), `skip {what}`, `commitMerge` (`commit --no-edit`), `stashDrop`. Handlers: `git.conflicts` → conflictInfo, `git.conflict` → readConflict.
- Palette `runOnFocused` failure message appends "N conflicts: open the Git panel to resolve them" when conflicts exist.

- [ ] Step 1: tests `conflictInfo for merge` (labels branch/merged ref, type UU), `labels for rebase`, `readConflict stages`, `writeResolved stages result` (status no longer conflicted, worktree content equals), `writeResolved keeps CRLF`, `resolveSide ours/theirs`, `resolveSide on deleted-by-them`, `binary and non-utf8 files are whole-file only`.
- [ ] Step 2: run, expect failures. Step 3: implement. Step 4: `npm test` passes.

### Task 3: Conflicts dialog, banner and finish actions (panel)

**Files:** Modify `panel/app.js`, `panel/index.html` (overlay containers), `panel/style.css`

- [ ] Banner: shown when `inProgress` or conflicts exist. Conflicts → **Resolve conflicts…** + Abort (when op). No conflicts: merge → **Commit merge**; rebase/cherry-pick/revert → **Continue**, **Skip**; after stash-style conflicts were resolved (panel remembers `state.stashConflict`) → "Conflicts resolved. The stash was kept." **Drop stash** (confirmed) + **Dismiss**.
- [ ] Conflicts dialog (`#conflicts` overlay): rows with path, type, Accept Yours / Accept Theirs / Merge… (Merge… hidden for structural/binary is decided on open by `git.conflict` `whole`), multi-select, Close. Rerenders on status changes; empty → finish buttons as in the banner.
- [ ] Auto-open: after `act()` of `pull|merge|rebase|cherryPick|revert|stashPop|updateBranch|continue|skip` and after `repo.changed` from palette pull, if conflict count went from 0 to >0, open the dialog.
- [ ] Changes view: double-click conflicted file → merge view; context menu Accept Yours / Accept Theirs / Merge….
- [ ] Continue failing with "nothing to commit"/"now empty" → toast pointing at Skip.

### Task 4: Merge view (panel)

**Files:** Create `panel/mergeview.js` (DOM for the overlay, uses `merge.js`); Modify `panel/app.js`, `panel/index.html`, `panel/style.css`

- [ ] Overlay `#mergeView` over the views; toolbar: prev/next, counter "N conflicts left · M changes", Apply non-conflicting, Accept Yours, Accept Theirs, Cancel, Apply. Pane headers with labels.
- [ ] One vertical scroller; each region is a grid row of three cells so chunks align; lines wrap (our call: replaces per-pane horizontal scroll, keeps alignment exact); line numbers per side.
- [ ] Result cells are `contenteditable="plaintext-only"`; input in a chunk cell → `setManual` (EOL of the file reapplied, last region keeps its missing final newline).
- [ ] Gutter buttons `>>` / `<<` / `×` per pending side; F7/Shift+F7 next/prev unresolved; Escape = Cancel.
- [ ] Warning bar when `current` has no conflict markers, with **Use current file as Result** (all chunks manual from current text: one equal region).
- [ ] Apply: confirm if unresolved conflicts; `writeResolved`; back to dialog/Changes. Cancel with changes → confirm discard. `setRepo` while open and dirty → confirm; automatic follow-focus does not switch while open.
- [ ] `ui.show` accepts `{ merge: path }` (opens the merge view for that file) — used for the screenshot.

### Task 5: Verify in Orca, screenshot, release

- [ ] `npm test`, `orca plugin validate .`, `orca plugin dev reload`.
- [ ] Demo repo with a merge conflict (outside the plugin folder), opened as an Orca workspace; exercise dialog, merge view (take, ignore, edit, Apply), Continue/Commit merge, refresh while overlay open.
- [ ] `orca plugin shot` the merge view → `media/merge-dark.png`; add to README (Changes section → new "Merge conflicts" section) and manifest screenshots; bump version to 0.4.0; update description.
