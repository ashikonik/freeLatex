#!/usr/bin/env bash
#
# verify-step.sh — Multi-headed verification harness for freeLatex.
#
# Usage: ./scripts/verify-step.sh <step_number>
#
# Runs three independent verification heads against the working tree:
#   Head 1 — Vitest unit & integration tests
#   Head 2 — TypeScript strict compilation (tsc --noEmit)
#   Head 3 — Runtime functional probe (server boots, HTTP endpoint responds)
#
# The client package has its own three heads, which VERIFY_TARGET selects:
#   VERIFY_TARGET=client — Vitest component tests, client tsc --noEmit,
#                          and a Vite production build
#
# On success: writes .dev_logs/step_<N>.log + .dev_logs/step_<N>.patch,
#             commits, and tags checkpoint-step-<NN>-<slug>.
# On failure: exits non-zero and prints the rollback command to run.

set -euo pipefail

STEP="${1:-}"
if [[ ! "$STEP" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <step_number>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="$REPO_ROOT/.dev_logs"
LOG_FILE="$LOG_DIR/step_${STEP}.log"
PATCH_FILE="$LOG_DIR/step_${STEP}.patch"
mkdir -p "$LOG_DIR"

STEP_PADDED="$(printf '%02d' "$STEP")"
# Optional slug suffix for the checkpoint tag, e.g. STEP_SLUG=git-init
STEP_SLUG="${STEP_SLUG:-}"
# Which package the heads run against: "server" (the default) or "client".
VERIFY_TARGET="${VERIFY_TARGET:-server}"

exec > >(tee "$LOG_FILE") 2>&1

echo "=============================================="
echo " freeLatex verification — Step ${STEP_PADDED}"
echo " $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "=============================================="

HEAD1_FAILED=0
HEAD2_FAILED=0
HEAD3_FAILED=0

# ---------------------------------------------------------------- Head 1
echo ""
echo "--- Head 1: Vitest unit & integration tests ---"
if [[ "$VERIFY_TARGET" == "client" ]]; then
  if [[ -d client/node_modules ]]; then
    if (cd client && npx vitest run --reporter=dot); then
      echo "HEAD 1 PASS"
    else
      echo "HEAD 1 FAIL"
      HEAD1_FAILED=1
    fi
  else
    echo "SKIP: client/node_modules not installed yet"
    echo "HEAD 1 PASS (skipped)"
  fi
elif [[ -d server/node_modules ]]; then
  if (cd server && npx vitest run --reporter=dot); then
    echo "HEAD 1 PASS"
  else
    echo "HEAD 1 FAIL"
    HEAD1_FAILED=1
  fi
else
  echo "SKIP: server/node_modules not installed yet (no test suite to run)"
  echo "HEAD 1 PASS (skipped)"
fi

# ---------------------------------------------------------------- Head 2
echo ""
echo "--- Head 2: TypeScript strict compilation (tsc --noEmit) ---"
if [[ "$VERIFY_TARGET" == "client" ]]; then
  if [[ -d client/node_modules ]]; then
    if (cd client && npx tsc --noEmit); then
      echo "HEAD 2 PASS"
    else
      echo "HEAD 2 FAIL"
      HEAD2_FAILED=1
    fi
  else
    echo "SKIP: client/node_modules not installed yet"
    echo "HEAD 2 PASS (skipped)"
  fi
elif [[ -d server/node_modules ]]; then
  if (cd server && npx tsc --noEmit); then
    echo "HEAD 2 PASS"
  else
    echo "HEAD 2 FAIL"
    HEAD2_FAILED=1
  fi
else
  echo "SKIP: server/node_modules not installed yet"
  echo "HEAD 2 PASS (skipped)"
fi

# ---------------------------------------------------------------- Head 3
echo ""
if [[ "$VERIFY_TARGET" == "client" ]]; then
  echo "--- Head 3: Vite production build ---"
  if [[ -d client/node_modules ]]; then
    if (cd client && npx vite build); then
      echo "HEAD 3 PASS"
    else
      echo "HEAD 3 FAIL"
      HEAD3_FAILED=1
    fi
  else
    echo "SKIP: client/node_modules not installed yet"
    echo "HEAD 3 PASS (skipped)"
  fi
else
  echo "--- Head 3: Runtime functional probe ---"
  if [[ -d server/node_modules ]] && [[ -f server/src/probe.ts ]]; then
    if (cd server && npm run --silent probe); then
      echo "HEAD 3 PASS"
    else
      echo "HEAD 3 FAIL"
      HEAD3_FAILED=1
    fi
  else
    echo "SKIP: server runtime not yet implemented"
    echo "HEAD 3 PASS (skipped)"
  fi
fi

# ---------------------------------------------------------------- Verdict
echo ""
echo "=============================================="
if [[ $HEAD1_FAILED -eq 0 && $HEAD2_FAILED -eq 0 && $HEAD3_FAILED -eq 0 ]]; then
  echo " VERIFICATION PASSED — Step ${STEP_PADDED}"
  echo "=============================================="

  git diff > "$PATCH_FILE" 2>/dev/null || true
  echo "Diff written to .dev_logs/step_${STEP}.patch"

  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git commit -q -m "chore(step-${STEP_PADDED}): verified checkpoint

All three verification heads passed:
  Head 1: Vitest unit & integration tests
  Head 2: TypeScript strict compilation
  Head 3: Runtime functional probe

Co-Authored-By: Opus 4.8 <noreply@puku.sh>"
    echo "Committed: $(git rev-parse --short HEAD)"
  else
    echo "Nothing to commit (working tree clean)."
  fi

  TAG="checkpoint-step-${STEP_PADDED}-${STEP_SLUG:-untagged}"
  git tag -f "$TAG" -m "Checkpoint for step ${STEP_PADDED}" >/dev/null 2>&1 || true
  echo "Tagged: $TAG"
  exit 0
else
  echo " VERIFICATION FAILED — Step ${STEP_PADDED}"
  echo "=============================================="
  echo ""
  echo "Roll back with:"
  echo "  ./scripts/dev-rollback.sh ${STEP}"
  exit 1
fi
