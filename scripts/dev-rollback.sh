#!/usr/bin/env bash
#
# dev-rollback.sh — Revert the repository to the previous verified checkpoint.
#
# Usage: ./scripts/dev-rollback.sh <step_number>
#
# Resets the working tree and HEAD to checkpoint-step-<N-1>, discarding any
# uncommitted changes made after that checkpoint.

set -euo pipefail

STEP="${1:-}"
if [[ ! "$STEP" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <step_number>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "$STEP" -le 0 ]]; then
  echo "Step 0 has no earlier checkpoint; nothing to roll back to." >&2
  exit 2
fi

PREV=$(printf '%02d' $((STEP - 1)))

# Checkpoint tags may carry a descriptive slug suffix (e.g. checkpoint-step-00-git-init).
TARGET=$(git tag -l "checkpoint-step-${PREV}*" --sort=creatordate | tail -n 1)

if [[ -z "$TARGET" ]]; then
  echo "No checkpoint found for step ${PREV}. Available checkpoints:" >&2
  git tag -l 'checkpoint-step-*' >&2
  exit 1
fi

echo "Rolling back to $TARGET ($(git rev-parse --short "$TARGET"))..."
echo ""

# Uncommitted work is discarded — that is the point of a rollback.
git reset --hard "$TARGET"
git clean -fd --exclude=.dev_logs

echo ""
echo "Rolled back to $TARGET."
echo "Current HEAD: $(git log -1 --oneline)"
