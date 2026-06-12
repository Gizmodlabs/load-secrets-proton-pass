#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Tee all stdout/stderr to a log file under tests/.output/ (gitignored).
LOG_FILE="$PROJECT_DIR/tests/.output/test-run.log"
mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee "$LOG_FILE") 2>&1
echo "Log: $LOG_FILE"
echo ""

PASS=0
FAIL=0

assert_exit_code() {
  local expected="$1" actual="$2" test_name="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  PASS: $test_name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $test_name (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# Set up mock CLI
MOCK_BIN=$(mktemp -d)
cp "$SCRIPT_DIR/mock-pass-cli.sh" "$MOCK_BIN/pass-cli"
chmod +x "$MOCK_BIN/pass-cli"
export PATH="$MOCK_BIN:$PATH"

# Set up mock GITHUB_ENV (the action writes resolved secrets here for subsequent steps)
MOCK_ENV=$(mktemp)
export GITHUB_ENV="$MOCK_ENV"

# Set up mock GITHUB_OUTPUT (the action writes the resolved-keys step output here)
MOCK_OUTPUT=$(mktemp)
export GITHUB_OUTPUT="$MOCK_OUTPUT"

cleanup() {
  rm -rf "$MOCK_BIN" "$MOCK_ENV" "$MOCK_OUTPUT"
}
trap cleanup EXIT

echo "=== Test Suite: load-secrets-proton-pass ==="
echo ""

# Test 1: No pass:// URIs — should be a no-op
echo "Test 1: No secrets to resolve (no-op)"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  NORMAL_VAR="hello" MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "No pass:// URIs resolves successfully"
echo ""

# Test 2: Single pass:// URI exported to GITHUB_ENV
echo "Test 2: Resolve a pass:// URI"
: > "$MOCK_ENV"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  DB_PASSWORD="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "pass:// URI resolved"
grep -q "DB_PASSWORD" "$MOCK_ENV"
assert_exit_code 0 $? "DB_PASSWORD written to GITHUB_ENV"
grep -q "mock-real-password" "$MOCK_ENV"
assert_exit_code 0 $? "Correct value in GITHUB_ENV"
echo ""

# Test 3: Template injection
echo "Test 3: Template file processing"
TEMPLATE_DIR=$(mktemp -d)
TEMPLATE="${TEMPLATE_DIR}/test.env.template"
cat > "$TEMPLATE" <<'TMPL'
DB_HOST=localhost
DB_PASSWORD={{ pass://GithubActions/load-secrets-proton-pass-test/Password }}
API_KEY={{ pass://GithubActions/load-secrets-proton-pass-test/Email }}
TMPL
EXPECTED_OUTPUT="${TEMPLATE%.template}"
ENV_TEMPLATE="$TEMPLATE" MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/inject-template.sh"
assert_exit_code 0 $? "Template injection ran"
if [[ -f "$EXPECTED_OUTPUT" ]]; then
  grep -q "mock-injected-value" "$EXPECTED_OUTPUT"
  assert_exit_code 0 $? "Template values injected"
else
  echo "  FAIL: Output file not created at $EXPECTED_OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$TEMPLATE_DIR"
echo ""

# Test 3b: Explicit output-path overrides auto-derived destination
# Writes into tests/.output/ (gitignored) so the rendered file is inspectable.
echo "Test 3b: Output-path override"
OUTPUT_DIR="$PROJECT_DIR/tests/.output"
mkdir -p "$OUTPUT_DIR"
TEMPLATE="$OUTPUT_DIR/test.env.template"
OVERRIDE="$OUTPUT_DIR/.env.production"
rm -f "$OVERRIDE" "${TEMPLATE%.template}"
cat > "$TEMPLATE" <<'TMPL'
DB_PASSWORD={{ pass://GithubActions/load-secrets-proton-pass-test/Password }}
TMPL
ENV_TEMPLATE="$TEMPLATE" OUTPUT_PATH="$OVERRIDE" MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/inject-template.sh"
assert_exit_code 0 $? "Injection with output-path ran"
[[ -f "$OVERRIDE" ]] && grep -q "mock-injected-value" "$OVERRIDE"
assert_exit_code 0 $? "Output written to override path with injected value"
echo "  -> Rendered file: $OVERRIDE"
echo ""

# Test 4: Cleanup script runs without error
echo "Test 4: Cleanup"
bash "$PROJECT_DIR/scripts/cleanup.sh"
assert_exit_code 0 $? "Cleanup completed"
echo ""

# Test 5: Multiple secrets in one run, mixed with non-secret env vars
echo "Test 5: Multiple secrets"
: > "$MOCK_ENV"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  SECRET_A="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  SECRET_B="pass://GithubActions/load-secrets-proton-pass-test/Email" \
  NOT_A_SECRET="just-a-value" \
  MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Multiple secrets resolved"
grep -q "SECRET_A" "$MOCK_ENV"
assert_exit_code 0 $? "SECRET_A in GITHUB_ENV"
rc=0
grep -q "NOT_A_SECRET" "$MOCK_ENV" || rc=$?
assert_exit_code 1 $rc "Non-pass:// vars left alone"
echo ""

# Test 6: Missing template file should error, not silently succeed
echo "Test 6: Missing template file"
MISSING="$PROJECT_DIR/tests/.output/does-not-exist.template"
rm -f "$MISSING"
err_out=$(ENV_TEMPLATE="$MISSING" MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/inject-template.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Inject errors when template missing"
grep -q "Template file not found" <<< "$err_out"
assert_exit_code 0 $? "Error message mentions missing template"
echo ""

# Test 7: Field glob — expand pass://V/item/* into one env var per field
echo "Test 7: Field glob happy path"
: > "$MOCK_ENV"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  DB="pass://GithubActions/multi-field-item/*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Field glob resolved"
grep -q "^DB_HOST<<" "$MOCK_ENV"
assert_exit_code 0 $? "DB_HOST written"
grep -q "^DB_PORT<<" "$MOCK_ENV"
assert_exit_code 0 $? "DB_PORT written"
grep -q "^DB_PASSWORD<<" "$MOCK_ENV"
assert_exit_code 0 $? "DB_PASSWORD written"
grep -q "db.example.com" "$MOCK_ENV"
assert_exit_code 0 $? "Resolved value present"
echo ""

# Test 8: Empty match — item with zero fields must fail
echo "Test 8: Empty field match fails"
: > "$MOCK_ENV"
err_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  EMPTY="pass://GithubActions/empty-item/*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Empty glob exits non-zero"
grep -q "matched zero fields" <<< "$err_out"
assert_exit_code 0 $? "Error message mentions zero fields"
echo ""

# Test 9: Collision — two fields sanitize to the same suffix
echo "Test 9: Collision fails with offending names"
: > "$MOCK_ENV"
err_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  X="pass://GithubActions/collision-item/*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Collision exits non-zero"
grep -q "api-key" <<< "$err_out"
assert_exit_code 0 $? "Error lists api-key"
grep -q "api_key" <<< "$err_out"
assert_exit_code 0 $? "Error lists api_key"
echo ""

# Test 10: Wildcards rejected in vault and item segments
echo "Test 10: Vault/item wildcards rejected"
: > "$MOCK_ENV"
err_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  BAD="pass://GithubActions/*/password" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Item wildcard exits non-zero"
grep -q "only supported in the field segment" <<< "$err_out"
assert_exit_code 0 $? "Error points at supported form"

: > "$MOCK_ENV"
err_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  BAD="pass://*/item/password" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Vault wildcard exits non-zero"
grep -q "only supported in the field segment" <<< "$err_out"
assert_exit_code 0 $? "Vault wildcard error points at supported form"
echo ""

# Test 11: Sanitization — mixed-case/space/dash field names map to clean suffixes
echo "Test 11: Field-name sanitization"
: > "$MOCK_ENV"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  CFG="pass://GithubActions/sanitize-item/*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Sanitize glob resolved"
grep -q "^CFG_API_KEY<<" "$MOCK_ENV"
assert_exit_code 0 $? "'API Key' -> CFG_API_KEY"
grep -q "^CFG_DATABASE_NAME<<" "$MOCK_ENV"
assert_exit_code 0 $? "'database-name' -> CFG_DATABASE_NAME"
grep -q "sanitize-apikey-value" "$MOCK_ENV"
assert_exit_code 0 $? "'API Key' value resolved"
echo ""

# Test 12: Glob masking — every expanded value gets its own ::add-mask::
echo "Test 12: Glob masking emits add-mask per value"
: > "$MOCK_ENV"
out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  DB="pass://GithubActions/multi-field-item/*" \
  MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh")
assert_exit_code 0 $? "Masked glob resolved"
grep -q "::add-mask::hunter2" <<< "$out"
assert_exit_code 0 $? "password value masked"
grep -q "::add-mask::db.example.com" <<< "$out"
assert_exit_code 0 $? "host value masked"
grep -q "^DB_PASSWORD<<" "$MOCK_ENV"
assert_exit_code 0 $? "DB_PASSWORD still written when masking"
echo ""

# Test 13: Glob and single URI coexist in one run
echo "Test 13: Glob and single URI in one run"
: > "$MOCK_ENV"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  DB="pass://GithubActions/multi-field-item/*" \
  PASSWORD="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Mixed run resolved"
grep -q "^DB_HOST<<" "$MOCK_ENV"
assert_exit_code 0 $? "Glob var written"
grep -q "^PASSWORD<<" "$MOCK_ENV"
assert_exit_code 0 $? "Single var written"
grep -q "mock-real-password" "$MOCK_ENV"
assert_exit_code 0 $? "Single value resolved"
echo ""

# Test 14: Field name that sanitizes to an empty suffix must fail
echo "Test 14: Empty-suffix field name fails"
: > "$MOCK_ENV"
err_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  BAD="pass://GithubActions/bad-suffix-item/*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Empty suffix exits non-zero"
grep -q "sanitizes to an empty suffix" <<< "$err_out"
assert_exit_code 0 $? "Error mentions empty suffix"
echo ""

# Test 15: Partial wildcard in field segment rejected with clear error
echo "Test 15: Partial field wildcard rejected"
: > "$MOCK_ENV"
err_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  BAD="pass://GithubActions/multi-field-item/pass*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Partial wildcard exits non-zero"
grep -q "Partial wildcards are not supported" <<< "$err_out"
assert_exit_code 0 $? "Error mentions partial wildcard"
echo ""

# Test 16: Strict mode (default) — unresolved URI fails the step with a report
echo "Test 16: Strict mode failure on missing item"
: > "$MOCK_ENV"
strict_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  GOOD_SECRET="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  BOGUS="pass://Prod/Does-Not-Exist/x" \
  MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 1 $rc "Missing item fails step by default"
rc=0
grep -q "BOGUS -> pass://Prod/Does-Not-Exist/x" <<< "$strict_out" || rc=$?
assert_exit_code 0 $rc "Failure report names var and URI"
rc=0
grep -q "GOOD_SECRET" "$MOCK_ENV" || rc=$?
assert_exit_code 0 $rc "Good secret still exported"
rc=0
grep -q "BOGUS" "$MOCK_ENV" || rc=$?
assert_exit_code 1 $rc "Unresolved var not written to GITHUB_ENV"
rc=0
grep "::error::" <<< "$strict_out" | grep -q "mock-real-password" || rc=$?
assert_exit_code 1 $rc "Failure report never contains secret values"
echo ""

# Test 17: strict=false — best-effort, step succeeds despite missing item
echo "Test 17: Best-effort mode (strict=false)"
: > "$MOCK_ENV"
lax_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  GOOD_SECRET="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  BOGUS="pass://Prod/Does-Not-Exist/x" \
  MASK_VALUES="true" STRICT="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 0 $rc "strict=false continues despite failure"
rc=0
grep -q "GOOD_SECRET" "$MOCK_ENV" || rc=$?
assert_exit_code 0 $rc "Good secret exported in best-effort mode"
rc=0
grep -q "::warning::" <<< "$lax_out" || rc=$?
assert_exit_code 0 $rc "Failures reported as warnings in best-effort mode"

# Test 18: strict=false — glob failures also demote to warnings
echo "Test 18: Best-effort mode covers glob failures"
: > "$MOCK_ENV"
lax_glob_out=$(env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" \
  EMPTY="pass://GithubActions/empty-item/*" \
  MASK_VALUES="false" STRICT="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh" 2>&1) && rc=0 || rc=$?
assert_exit_code 0 $rc "strict=false continues despite empty glob"
rc=0
grep -q "::warning::Glob pass://GithubActions/empty-item/\* matched zero fields" <<< "$lax_glob_out" || rc=$?
assert_exit_code 0 $rc "Empty glob reported as warning"
echo ""

# Test 19: resolved-keys output — sorted names of loaded vars, no values
echo "Test 19: resolved-keys output sorted, names only"
: > "$MOCK_ENV"
: > "$MOCK_OUTPUT"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" GITHUB_OUTPUT="$MOCK_OUTPUT" \
  ZEBRA_KEY="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  ALPHA_KEY="pass://GithubActions/load-secrets-proton-pass-test/Email" \
  MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Resolver ran"
rc=0
grep -q "^resolved-keys=ALPHA_KEY,ZEBRA_KEY$" "$MOCK_OUTPUT" || rc=$?
assert_exit_code 0 $rc "resolved-keys sorted comma-separated names"
rc=0
grep -q "mock-real-password" "$MOCK_OUTPUT" || rc=$?
assert_exit_code 1 $rc "No secret values in GITHUB_OUTPUT"
echo ""

# Test 20: resolved-keys written as empty string when nothing resolved
echo "Test 20: resolved-keys empty when zero secrets"
: > "$MOCK_ENV"
: > "$MOCK_OUTPUT"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" GITHUB_OUTPUT="$MOCK_OUTPUT" \
  NORMAL_VAR="hello" MASK_VALUES="true" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "No-op resolver ran"
rc=0
grep -q "^resolved-keys=$" "$MOCK_OUTPUT" || rc=$?
assert_exit_code 0 $rc "resolved-keys present and empty"
echo ""

# Test 21: resolved-keys includes glob-expanded var names
echo "Test 21: resolved-keys includes glob-expanded keys"
: > "$MOCK_ENV"
: > "$MOCK_OUTPUT"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" GITHUB_OUTPUT="$MOCK_OUTPUT" \
  DB="pass://GithubActions/multi-field-item/*" \
  MASK_VALUES="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Glob resolver ran"
rc=0
grep -q "^resolved-keys=DB_HOST,DB_PASSWORD,DB_PORT$" "$MOCK_OUTPUT" || rc=$?
assert_exit_code 0 $rc "Glob-expanded names listed sorted"
echo ""

# Test 22: best-effort mode — failed key excluded, resolved key listed
echo "Test 22: resolved-keys excludes unresolved vars (strict=false)"
: > "$MOCK_ENV"
: > "$MOCK_OUTPUT"
env -i PATH="$PATH" HOME="$HOME" GITHUB_ENV="$MOCK_ENV" GITHUB_OUTPUT="$MOCK_OUTPUT" \
  GOOD_SECRET="pass://GithubActions/load-secrets-proton-pass-test/Password" \
  BOGUS="pass://Prod/Does-Not-Exist/x" \
  MASK_VALUES="true" STRICT="false" \
  bash "$PROJECT_DIR/scripts/resolve-secrets.sh"
assert_exit_code 0 $? "Best-effort resolver ran"
rc=0
grep -q "^resolved-keys=GOOD_SECRET$" "$MOCK_OUTPUT" || rc=$?
assert_exit_code 0 $rc "Only resolved key listed"
echo ""

echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
