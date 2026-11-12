# Merge conflict resolution — design

Date: 2026-11-12
Status: approved in chat, builder check done, awaiting final review

## Intent

Git Toolbox can start merges, rebases, cherry-picks, reverts and pulls, and it already notices
when one stops on conflicts (the `inProgress` banner and the "Conflicts" group in Changes). What
it cannot do is help resolve them: today the user has to open each file in an editor and edit
`<<<<<<<` markers by hand.

The user resolves conflicts in their other IDE with a **three-pane merge view, accepting the left
or right side chunk by chunk**. That workflow is the target. Success means a user can go from
"pull stopped with conflicts" to "merge committed / rebase continued" without leaving the panel
and without touching a conflict marker.

The user handed all design choices to the builder ("do it in the best way"); every decision below
is ours and was played back and accepted.

## Goals

1. A conflicts dialog listing every conflicted file, with per-file **Accept Yours**,
   **Accept Theirs** and **Merge…**.
2. A three-pane merge view: Yours (left, read-only) · Result (middle, editable) · Theirs (right,
   read-only), with per-chunk accept actions.
3. Finishing the operation (commit / continue) from the panel once nothing is left unresolved.

## Non-goals (this version)

- Binary files in the merge view: they get only Accept Yours / Accept Theirs.
- Syntax highlighting inside the merge panes.
- A merge view for structural conflicts (deleted on one side and modified on the other, added
  on both sides with different modes, renames vs. delete). These get Yours / Theirs only; for
  delete/modify, "accept the deleting side" removes the file.
- Submodule conflicts.
- Undo history beyond what the Result editor's own text undo gives.
- A setting to pick the merge tool or call an external one.

## Anti-goals (would be a failure even if it "works")

- Losing the user's manual edits in Result without asking (closing, switching file, background
  refresh). The panel's background refresh must never re-render or replace an open merge view;
  this kind of overwrite has bitten this plugin before.
- Writing a result that still contains conflict markers without the user explicitly confirming.
- Silently changing a file's line endings or dropping/adding the final newline.

## Entry points

1. **Banner.** The existing in-progress banner (`renderBanner` in `panel/app.js`) gains a
   **Resolve conflicts…** button whenever there is at least one conflicted file. It opens the
   conflicts dialog.
2. **Automatically after an operation.** When an action run from the panel or a palette command
   (pull, merge, rebase, cherry-pick, revert, stash pop, update branch) ends with the repo in
   a conflicted state, the panel opens the conflicts dialog. If the operation came from a palette
   command while the panel is hidden, show a notification with the conflict count instead; the
   notification's click target (if Orca supports one) or the banner leads to the dialog.
3. **Changes view.** Double-clicking a file in the Conflicts group opens the merge view for that
   file directly. Its context menu offers Accept Yours / Accept Theirs / Merge….

## Conflicts dialog

A modal over the panel, styled like the existing `ask()` dialogs:

- Title: "Conflicts" plus the operation (e.g. "Merging origin/main into main").
- Column labels say what "Yours" and "Theirs" are for the current operation (see Naming).
- One row per conflicted file: path (folder dimmed, as in Changes), a short conflict type
  ("both modified", "deleted by them", "added by both", …) from the porcelain v2 `XY` code, and
  buttons **Accept Yours**, **Accept Theirs**, **Merge…** (Merge… hidden for binary and
  structural conflicts).
- Multi-select with Shift/Ctrl and the two Accept buttons apply to all selected rows.
- Resolved files leave the list. When the list is empty the dialog switches to the finish
  step (below).
- **Close** leaves the operation in progress; the banner remains as the way back.

## Merge view

A full-panel overlay (covers the Log/Changes area, same pattern as the switcher overlay), so it
gets the whole panel width. On narrow panels (the existing `setupNarrow` breakpoint) it stacks
nothing; it keeps three panes and lets each one scroll horizontally, since stacking breaks the
side-by-side comparison that is the point.

### Layout

```
[◀ prev] [next ▶]  3 conflicts left · 2 changes   [Apply non-conflicting] [Accept Yours] [Accept Theirs]   [Cancel] [Apply]
┌ Yours: main ───────┬ Result ─────────────────┬ Theirs: origin/main ┐
│        … line   >> │ … editable text …       │ << line …           │
└────────────────────┴─────────────────────────┴─────────────────────┘
```

- Header labels follow Naming below.
- The three panes scroll vertically together and stay aligned by chunk: when one side's chunk is
  longer, the shorter sides get filler space so chunk starts line up. Long lines wrap (builder's call) so alignment stays exact.
- Line numbers in each pane.

### Chunks

The view works on a three-way diff of **base**, **yours** and **theirs** (index stages 1, 2, 3).
Each region of the file is one of:

- **unchanged**: identical in all three;
- **change on one side only** (non-conflicting): shown highlighted in that side's pane;
- **same change on both sides**: treated as resolved, lightly highlighted;
- **conflict**: both sides changed the same base region differently; strong highlight.

Initial Result: base text with nothing applied, then the user drives it. This matches the
reference IDE: non-conflicting changes appear as pending chunks that **Apply non-conflicting**
(toolbar) applies in one go. (Builder may instead open with non-conflicting changes already
applied if that is markedly simpler; the user-visible requirement is that one click takes care of
all of them and the count reflects it.)

Per-chunk actions, in the gutter between panes:

- `>>` on the Yours side / `<<` on the Theirs side: put that side's lines into Result for this
  chunk.
- For a conflict, after taking one side, the other side's arrow stays available and **appends**
  its lines after the taken side's (so "take both" is two clicks, in either order).
- `×` on either side: ignore that side's change for this chunk. A chunk is resolved once each
  side has been either taken or ignored.
- Resolved chunks lose their strong highlight and their buttons; the counter updates.

The Result pane is a plain editable text area (monospace, same font as the diff view). The user
can type anywhere. If an edit touches a chunk's lines, that chunk counts as resolved (manual).
Exact tracking of chunk boundaries under free edits is a builder decision; the requirement is that
the counter and buttons never act on the wrong lines, and when in doubt a chunk is treated as
manually resolved rather than letting a later `>>` overwrite user text.

Navigation: **next/prev** buttons and F7 / Shift+F7 jump to the next/previous unresolved chunk and
scroll all three panes there.

Toolbar **Accept Yours** / **Accept Theirs** resolve the whole file with that side and close the
view (same as the dialog buttons).

### Apply and Cancel

- **Apply**: if unresolved conflicts remain, confirm ("2 conflicts are not resolved. Save anyway?
  Unresolved parts keep the base text."). Then write Result to the working-tree file and stage it
  (`git add`). Return to the conflicts dialog (or Changes if it was opened from there).
- **Cancel / Escape / closing the panel view**: if Result differs from its initial text, confirm
  discarding. Nothing is written.
- Switching project/worktree while a merge view is open asks the same discard question first.

## Whole-file resolution

- **Accept Yours / Theirs** on a both-modified/added file: `git checkout --ours|--theirs -- <path>`
  then `git add -- <path>`.
- When the chosen side deleted the file: `git rm -- <path>`.
- When the chosen side kept a file the other deleted: checkout that side, then `git add`.

## Finishing the operation

When no conflicted files remain and an operation is in progress, the banner (and the conflicts
dialog's final step) shows:

- **Merge**: "All conflicts resolved." with **Commit merge…**, which switches to Changes with the
  commit box prefilled from `.git/MERGE_MSG`. The existing commit flow does the commit.
- **Rebase**: **Continue rebase** (`git rebase --continue`, non-interactive editor:
  `GIT_EDITOR=true`). If the next step conflicts, the dialog opens again.
- **Cherry-pick / Revert**: **Continue** (`git cherry-pick|revert --continue`, same editor rule).
- **Abort** stays available throughout.

## Naming

Labels for the two sides depend on the operation, because in a rebase git's "ours" is the
upstream:

| Operation | Yours (stage 2) label | Theirs (stage 3) label |
|---|---|---|
| merge / pull (merge) | current branch name | merged ref (from `MERGE_HEAD`, named via `name-rev` or `MERGE_MSG`) |
| rebase / pull (rebase) | "Upstream (onto)" with the onto ref | "Your commit" with the commit subject being replayed |
| cherry-pick / revert | current branch | the picked/reverted commit's short hash + subject |

The words "Yours"/"Theirs" in buttons stay as they are; the pane headers carry the specific
names so the user knows which is which.

## Constraints

- The plugin is plain JS: no bundler and no runtime dependencies (`package.json` has only a test
  script). The three-way diff must be implemented in the worker or panel as plain code, not
  imported.
- Git runs through `runGit` in `worker/git.mjs`, including inside WSL from a Windows host
  (`buildCommand` routes through `wsl.exe`). Anything new must work through that path. Don't
  rely on temp files on the host side being visible to git inside WSL.
- The worker/panel split stays: the worker runs git and file I/O, the panel renders. Pure logic
  (three-way diff, chunk classification, marker detection, side naming) is exported and covered by
  `node --test` tests like the existing `tests/*.test.ts`.
- Reading stages: `git show :1:<path>`, `:2:`, `:3:` (a missing stage means that side added or
  deleted the file).
- Preserve the original file's line ending style (detect from the Yours stage) and final-newline
  state when writing Result.
- Large files: if any stage exceeds the existing diff size limit, offer only Yours/Theirs, plus
  "Open in editor" if Orca exposes a way to open a file.
- The manifest's capabilities (`workspace:read`, `workspace:write`, …) must cover writing the
  file. If writing through the workspace API is not possible, write through git
  (`hash-object -w --stdin` + checkout of that blob) so no new capability is needed.
- Release: this is a feature release (0.4.0). Update the README and the manifest description to
  mention conflict resolution. Add a screenshot of the merge view to `media/` and the manifest.
  Per the earlier decision, don't name other products anywhere.

## Decisions from the builder check (our calls)

1. **Conflicts with no operation in progress** (stash pop, the autostash of `pull --rebase`):
   the banner, the Resolve button and the dialog key off **"conflicted files exist"**, not off
   `inProgress`. In that state the sides are labelled "Current branch" (stage 2) and "Stash"
   (stage 3). The finish step only stages files. After that the banner says "Conflicts resolved.
   The stash was kept." and offers **Drop stash** (`git stash drop`, confirmed). No new stash-pop
   UI is added; `stashPop` stays an internal action.
2. **File already edited before the merge view opens.** If the working-tree file no longer
   contains any conflict marker (`<<<<<<<`, `=======`, `>>>>>>>` at line start), the merge view
   shows a warning bar: "This file was changed after the conflict. Apply will replace it." The
   bar has **Use current file as Result**, which loads the file into Result and marks every chunk
   as manually resolved. Files that still have markers are assumed untouched (partial hand-edits
   with markers left are an accepted risk; Cancel never writes).
3. **Line endings**: the merge works on the index-stage blobs exactly as git stores them, keeping each
   line's own terminator. Result is stored as a blob without filters (`hash-object --no-filters`),
   staged with `update-index --cacheinfo`, and checked out with `checkout-index`. Git's
   `autocrlf` / `.gitattributes` conversion then produces the working-tree file the same way it
   does for any checkout. No host-side file I/O, so it also works through WSL. Tests cover CRLF
   and a missing final newline.
4. **Empty commit after resolving** in a rebase or cherry-pick: the finish step shows **Skip**
   (`git rebase|cherry-pick --skip`) next to Continue and Abort. If Continue fails with git's
   "nothing to commit" / "previous cherry-pick is now empty" message, the toast says so and points
   at Skip.

## Left to the builder

- The diff algorithm (Myers, patience, histogram) and how base→yours and base→theirs diffs are
  merged into chunks.
- How the Result editor tracks chunk positions under free edits (within the rule above).
- Whether the three-way computation runs in the worker or the panel.
- Exact styling, colors (use the existing theme tokens in `panel/style.css`), icons, and keyboard
  shortcuts beyond F7/Shift+F7/Escape.
- How auto-opening the dialog after an operation is wired into `act()`/`tryAct()`.
