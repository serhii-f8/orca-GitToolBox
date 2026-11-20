#!/usr/bin/env bash
# Builds a Git Toolbox test project with lots of edge cases.
# usage: make-testbed.sh [dir]   (default: $TESTBED, else $TMPDIR/gtb-testbed). Deletes and rebuilds
# dir, dir-remote.git and dir-wt.
set -euo pipefail
ROOT="${1:-${TESTBED:-${TMPDIR:-/tmp}/gtb-testbed}}"
case "$ROOT" in
  /*/*) ;;
  *) echo "refusing to use '$ROOT': give an absolute path at least two levels deep" >&2; exit 1 ;;
esac
REMOTE="$ROOT-remote.git"
WT="$ROOT-wt"
rm -rf -- "$ROOT" "$REMOTE" "$WT"
git init -q --bare -b main "$REMOTE"
git init -q -b main "$ROOT"
cd "$ROOT"
git config user.name "Test Bot"; git config user.email "bot@example.invalid"
c() { git add -A; GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -q -m "$2"; }

printf 'line1\nline2\nline3\nline4\nline5\n' > app.txt
printf '# Testbed\n' > README.md
c "2026-11-01T10:00:00" "Initial commit"
mkdir -p src/deep/nested; echo 'export const a = 1' > src/deep/nested/a.js
c "2026-11-01T11:00:00" "Add nested source"
git remote add origin "$REMOTE"; git push -q -u origin main
git tag v1.0; git tag -a v1.1 -m "annotated tag"

# feature branch with slash, merged back with a merge commit
git switch -q -c feature/login
echo 'login' > login.txt; c "2026-11-02T10:00:00" "Add login"
echo 'login2' >> login.txt; c "2026-11-02T11:00:00" "Login: second step"
git switch -q main
echo 'main work' > main.txt; c "2026-11-02T12:00:00" "Main work in parallel"
git merge -q --no-ff feature/login -m "Merge branch 'feature/login'"
git push -q origin main feature/login --tags

# branch only on remote
git switch -q -c remote-only; echo r > r.txt; c "2026-11-03T10:00:00" "Remote only commit"
git push -q origin remote-only; git switch -q main; git branch -q -D remote-only

# conflict branches
git switch -q -c conflict/a
printf 'line1\nLINE2-from-A\nline3\nline4\nline5-A\n' > app.txt
echo 'A added' > addadd.txt
c "2026-11-04T10:00:00" "A edits app.txt"
git switch -q main
git switch -q -c conflict/b
printf 'line1\nLINE2-from-B\nline3\nline4\nline5-B\n' > app.txt
echo 'B added' > addadd.txt
git rm -q README.md
c "2026-11-04T11:00:00" "B edits app.txt and removes README"
git switch -q conflict/a
echo 'A changes readme' >> README.md; c "2026-11-04T12:00:00" "A edits README"
git switch -q main

# weird names, unicode, emoji, binary, long message, special chars in message
echo x > "file with spaces.txt"; echo y > "üñíçødé.txt"; echo z > "-dash-start.txt"
echo q > 'quote"and$dollar.txt'
head -c 2048 /dev/urandom > blob.bin
c "2026-11-05T10:00:00" $'Weird <b>names</b> & "quotes" <img src=x onerror=alert(1)>\n\nBody line 1\nBody line 2'
seq 1 5000 > big.txt; c "2026-11-05T11:00:00" "Add a big file"
git mv app.txt app-renamed.txt; c "2026-11-05T12:00:00" "Rename app.txt"
git mv app-renamed.txt app.txt; c "2026-11-05T12:30:00" "Rename back"
git push -q origin main

# make origin ahead (incoming) using a second clone
TMPC=$(mktemp -d); git clone -q "$REMOTE" "$TMPC/c"; (cd "$TMPC/c" && git config user.name Other && git config user.email o@example.invalid && echo up > upstream.txt && git add . && git commit -q -m "Upstream commit from teammate" && git push -q origin main); rm -rf "$TMPC"
git fetch -q origin
# local outgoing commit
echo out > outgoing.txt; c "2026-11-06T10:00:00" "Local outgoing commit"

# many commits for pagination on a side branch
git switch -q -c long-history
for i in $(seq 1 420); do echo $i > hist.txt; git add hist.txt; git commit -q -m "History commit $i"; done
git switch -q main

# worktree
git worktree add -q "$WT" -b wt-branch

# working tree state: staged, modified, untracked, deleted, unicode
echo staged > staged.txt; git add staged.txt
echo "modified" >> big.txt
rm main.txt
echo untracked > "new untracked ü.txt"
mkdir -p newdir/sub; echo n > newdir/sub/n.txt
echo stash-me >> login.txt; git stash push -q -m "a stash" login.txt
git status --short
