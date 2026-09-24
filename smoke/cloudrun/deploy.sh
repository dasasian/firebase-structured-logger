#!/usr/bin/env bash
# Deploy the Cloud Run smoke service from the working tree.
#
# Packs the repo into fsl-local.tgz beside server.js (npm pack is byte-identical to
# what npm publish would send), then builds from source. The project, bucket and app
# id come from smoke/.env.local and are passed explicitly — nothing here relies on
# gcloud's active project.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
env_file="$repo/smoke/.env.local"

value() { grep "^$1=" "$env_file" | cut -d= -f2- || true; }  # a missing key is empty, not fatal
project="$(value FSL_SMOKE_PROJECT)"
bucket="$(value FSL_SMOKE_BUCKET)"
app_id="$(value FSL_SMOKE_APP_ID)"
region="$(value FSL_SMOKE_REGION)"
region="${region:-us-central1}"

if [[ -z "$project" || -z "$bucket" ]]; then
  echo "FSL_SMOKE_PROJECT and FSL_SMOKE_BUCKET must be set in smoke/.env.local" >&2
  exit 1
fi

(cd "$repo" && npm run clean >/dev/null && npm run build >/dev/null)
rm -f "$here"/*.tgz
tarball="$(cd "$repo" && npm pack --silent --pack-destination "$here" | tail -1)"
mv "$here/$tarball" "$here/fsl-local.tgz"

gcloud run deploy fsl-cloudrun-smoke \
  --project "$project" \
  --region "$region" \
  --source "$here" \
  --no-allow-unauthenticated \
  --set-env-vars "FSL_SMOKE_BUCKET=$bucket,FSL_SMOKE_APP_ID=${app_id:-smoke-app}" \
  --quiet
