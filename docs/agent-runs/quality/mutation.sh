#!/usr/bin/env bash
# Mutation testing of a checkout's tests with Stryker. Stryker is installed with --no-save, so the
# project's package files stay as they are; still, run it in a throw-away clone.
# Usage: mutation.sh <checkout>   (dependencies installed; backend client generated)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$1" && pwd)
for app in backend frontend; do
  cd "$root/$app"
  npm i --no-save --silent @stryker-mutator/core@10.1.1 @stryker-mutator/vitest-runner@10.1.1
  cp "$here/$app.stryker.json" stryker.config.json
  start=$(date +%s)
  npx stryker run --logLevel warn
  echo "$app: $(( $(date +%s) - start )) s, report in $root/$app/reports/mutation.json"
  rm stryker.config.json
done
