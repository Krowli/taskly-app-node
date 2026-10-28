#!/usr/bin/env bash
# Measures the (already applied) agent patch. This runs PR and agent code,
# so it only produces data (into $OUT) for judge.sh; it never decides.
# Usage: measure.sh [baseline]. Env: IN (analysis/, agent/), OUT, MODE (pr|coverage), BASE, HEAD_SHA.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = baseline ]; then
  # Clean-head results and coverage, for "coverage before -> after".
  mkdir -p .unit-test-agent
  for app in backend frontend; do
    (cd "$app" && ./node_modules/.bin/vitest run --coverage --coverage.reporter=json --coverage.reporter=json-summary \
      --coverage.reportOnFailure --reporter=json --outputFile="../.unit-test-agent/results-$app.json") || true
  done
  exit 0
fi
mkdir -p "$OUT/stability"
# The gate (gate.sh) has already applied the agent's patch with --index and installed dependencies;
# this script only measures, inside a container with no network.

# Typecheck and full suites with coverage, per app.
for app in backend frontend; do
  if npm run typecheck --prefix "$app"; then echo pass > "$OUT/typecheck-$app"; else echo fail > "$OUT/typecheck-$app"; fi
  (cd "$app" && ./node_modules/.bin/vitest run --coverage --coverage.reporter=json --coverage.reporter=json-summary \
    --coverage.reportOnFailure --reporter=json --outputFile="$OUT/results-$app.json") || true
  mkdir -p "$OUT/coverage/$app/coverage" && cp "$app/coverage/coverage-summary.json" "$OUT/coverage/$app/coverage/" 2>/dev/null || true
done

# Runnable test files from the patch (helpers like fixture.ts run through them).
git -c core.quotePath=false diff --cached --name-only | grep -E '\.test\.tsx?$' > "$OUT/patched-tests.txt" || true
patched() { grep "^$1/" "$OUT/patched-tests.txt" | sed "s#^$1/##"; }

# Every test asserts something; 3 more runs plus one in shuffled order catch flakiness.
echo pass > "$OUT/require-assertions"
for app in backend frontend; do
  mapfile -t files < <(patched "$app")
  [ "${#files[@]}" -eq 0 ] && continue
  (cd "$app" && ./node_modules/.bin/vitest run --expect.requireAssertions "${files[@]}") || echo fail > "$OUT/require-assertions"
  for i in 1 2 3; do (cd "$app" && ./node_modules/.bin/vitest run "${files[@]}" --reporter=json --outputFile="$OUT/stability/$app-$i.json") || true; done
  (cd "$app" && ./node_modules/.bin/vitest run --sequence.shuffle.files --sequence.shuffle.tests --reporter=json --outputFile="$OUT/stability/$app-shuffled.json") || true
done

# Fails without the change: the PR's modified source files go back to the merge base and the patched tests run again.
echo '{"applicable":false,"newTests":0,"failingOnBase":0}' > "$OUT/fails-without-change.json"
if [ "$MODE" = pr ]; then
  mapfile -t modified < <(node -e 'for (const f of require(process.argv[1]).files) if (f.testable && f.status === "M") console.log(f.path)' "$IN/analysis/.unit-test-agent/manifest.json")
  if [ "${#modified[@]}" -gt 0 ]; then
    git checkout "$(git merge-base "$BASE" "$HEAD_SHA")" -- "${modified[@]}"
    for app in backend frontend; do
      mapfile -t files < <(patched "$app")
      [ "${#files[@]}" -eq 0 ] && continue
      (cd "$app" && ./node_modules/.bin/vitest run "${files[@]}" --reporter=json --outputFile="$OUT/fails-without-change-$app.json") || true
    done
    git checkout HEAD -- "${modified[@]}"
    node "$here/fails-without-change.mjs" "$OUT"
  fi
  node "$here/change-manifest.mjs" --mode pr --base "$BASE" --head "$HEAD_SHA" --out "$OUT/manifest-after.json"
fi
