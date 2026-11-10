# Git Toolbox for Orca

A PhpStorm-style Git panel for [Orca](https://github.com/stablyai/orca), with GitToolBox-style status tracking.

## Features

**Git panel (right sidebar → Git)**
- **Project and worktree switcher:** click the project name in the toolbar (or press Ctrl/Cmd+K in the panel) to see
  every Orca workspace grouped under its repository. Type to filter, Enter shows that worktree's Git, and
  Shift+Enter or the open button also opens it in Orca. By default the panel follows the workspace open in Orca.
- **Quiet refresh:** data refreshes in the background after actions, fetches and window focus. Only what changed
  is redrawn; scroll positions, the selected commit and open diffs stay put.
- **Branch tree:** HEAD, Local (current and favorites first, `/` grouped into folders), Remote (per remote) and Tags.
  Shows incoming ↙ and outgoing ↗ commit counts against the upstream, and marks upstreams that are *gone*.
  Click a branch to filter the log; double-click to check it out. The context menu has checkout, new branch,
  merge, rebase, update (fast-forward), push, rename, delete, favorites and "commits not in current branch".
- **Log:** a commit graph with colored lanes and ref badges (`origin & main`). Filter by text or hash, branch, user
  and date. More commits load as you scroll; arrow keys move the selection. The context menu has copy hash or
  message, checkout revision, new branch or tag, cherry-pick, revert and reset (soft/mixed/keep/hard).
- **Commit details:** changed files (click one for its diff), full message, author and committer, parents, and the
  branches that contain the commit.
- **Changes:** conflicts, staged, unstaged and unversioned files, each with stage, unstage and rollback; a diff
  preview; commit, amend, and commit-and-push (Ctrl/Cmd+Enter commits). A banner offers Abort while a merge,
  rebase, cherry-pick or revert is in progress.
- **Toolbar:** fetch, update (pull), push, new branch and refresh. Checkout offers to stash local changes when they
  would be overwritten.

**Status bar:** the current branch with `↑ahead ↓behind` and `*` for local changes; click it to fetch.

**Auto-fetch:** fetches in the background (default every 15 minutes) and can notify you when the branch falls behind.

**Commands:** *Git Toolbox: Fetch / Update (Pull) / Push* (Update is bound to `Mod+Shift+T`).

**Settings:** auto-fetch interval, status refresh interval, behind notifications, pull mode
(merge / rebase / fast-forward only) and log page size.

## How it works

`worker/main.mjs` is the plugin's Node worker; it runs git and answers the panel's requests (`panel/app.js`).
When Orca runs on Windows and a workspace lives in WSL (`\\wsl.localhost\<distro>\...`), git runs inside the
distro through `wsl.exe --exec`, so you get Linux git, its credentials and its speed. Commit messages go to git
through stdin, and branch names typed in the panel are checked before they reach git.

## Development

```sh
npm test                                   # node tests: parsers, graph layout, a real temp repo
orca plugin dev watch . --json             # on the Orca host (Windows path for WSL folders)
```

Keep screenshots (`--shot <dir>`) outside the plugin folder: files written inside it change the content hash
and Orca stops the worker until you approve again.
