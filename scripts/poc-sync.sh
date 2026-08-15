#!/usr/bin/env bash
# Point the POC preview at a commit and restart it.
#
# The preview runs from its own git worktree and its own database, so the
# production app on time.rigid-dreamy-sweep.us keeps its real data untouched.
# Alt+drag feedback from the preview is written into the MAIN repo's feedback/
# and TODO.md (see the service unit), so review happens where the code is.
#
#   scripts/poc-sync.sh              # move the preview to the current HEAD
#   scripts/poc-sync.sh <ref>        # move it to a specific commit or branch
#   scripts/poc-sync.sh --seed       # also rebuild the demo data from scratch
set -euo pipefail

MAIN="$HOME/Projects/Intapp-clone"
POC="$HOME/Projects/timekeeper-poc"
PORT=4748
REF=""
SEED=0

for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    *) REF="$arg" ;;
  esac
done
[ -z "$REF" ] && REF="$(git -C "$MAIN" rev-parse HEAD)"

if [ ! -d "$POC" ]; then
  echo "creating the preview worktree at $POC"
  git -C "$MAIN" worktree add --detach "$POC" "$REF"
  # The worktree has no node_modules of its own and the dependency set is
  # identical, so share the main checkout's.
  ln -sfn "$MAIN/node_modules" "$POC/node_modules"
  mkdir -p "$POC/data"
else
  git -C "$POC" fetch --all --quiet || true
  git -C "$POC" checkout --detach "$REF" --quiet
fi

echo "preview is at $(git -C "$POC" log --oneline -1)"

if [ "$SEED" = "1" ]; then
  rm -f "$POC"/data/timekeeper.db*
  echo "database cleared; it will be reseeded on next start"
fi

systemctl --user restart timekeeper-poc
sleep 2
systemctl --user is-active timekeeper-poc
curl -s -o /dev/null -w "local http %{http_code}\n" "http://127.0.0.1:$PORT/"
