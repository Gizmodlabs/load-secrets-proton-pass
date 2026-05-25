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

cleanup() {
  rm -rf "$MOCK_BIN" "$MOCK_ENV"
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

echo "=== Results: $PASS passed, $FAIL failed ==="
[[ "$FAIL" -eq 0 ]] || exit 1
