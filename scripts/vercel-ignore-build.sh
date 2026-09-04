#!/usr/bin/env bash
set -euo pipefail

BASE_SHA="${VERCEL_GIT_PREVIOUS_SHA:-}"

# Vercel uses exit 0 to skip a build and exit 1 to continue it.
# Fail open: when the previous deployed SHA is unavailable or invalid,
# continue the build rather than risk skipping a required production update.
if [[ -z "$BASE_SHA" ]] || ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  echo "VERCEL_GIT_PREVIOUS_SHA unavailable; continuing Vercel build."
  exit 1
fi

RELEVANT_PATHS=(
  "public"
  "api"
  "services/api/src/market-intelligence.mjs"
  "package.json"
  "package-lock.json"
  "vercel.json"
  "scripts/vercel-ignore-build.sh"
)

if git diff --quiet "$BASE_SHA" HEAD -- "${RELEVANT_PATHS[@]}"; then
  echo "No public-edge changes since ${BASE_SHA}; skipping Vercel build."
  exit 0
fi

echo "Public-edge changes detected since ${BASE_SHA}; continuing Vercel build."
exit 1
