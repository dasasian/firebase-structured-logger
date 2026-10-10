#!/usr/bin/env bash
# Packs the working tree, builds the smoke functions against it, and deploys them
# to FSL_SMOKE_PROJECT. The live smoke tests the code about to ship; what npm users
# install is smoke:install's job.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
env_file="$repo/smoke/.env.local"

project="$(grep '^FSL_SMOKE_PROJECT=' "$env_file" | cut -d= -f2- || true)"
if [[ -z "$project" ]]; then
  echo "FSL_SMOKE_PROJECT must be set in smoke/.env.local" >&2
  exit 1
fi

(cd "$repo" && npm run clean >/dev/null && npm run build >/dev/null)
rm -f "$here"/*.tgz
tarball="$(cd "$repo" && npm pack --silent --pack-destination "$here" | tail -1)"
mv "$here/$tarball" "$here/fsl-local.tgz"

rm -rf "$here/node_modules/@dasasian/firebase-structured-logger"
(cd "$here" && npm install --no-package-lock --silent && npm run build)

(cd "$repo/smoke" && firebase deploy --only functions --project "$project")
