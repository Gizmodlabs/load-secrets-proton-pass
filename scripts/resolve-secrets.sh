#!/usr/bin/env bash
set -euo pipefail

PASS_URI_PATTERN="^pass://(.+)/(.+)/(.+)$"
RESOLVED_COUNT=0
STRICT="${STRICT:-true}"
FAILURES=()
RESOLVED_KEYS=()

# Failures annotate as errors in strict mode, warnings in best-effort mode
ANNOTATE="error"
[[ "$STRICT" == "true" ]] || ANNOTATE="warning"

# Capture pass-cli stderr separately so a failed command's stdout (potential
# secret material) is never echoed into the logs
STDERR_FILE=$(mktemp)
trap 'rm -f "$STDERR_FILE"' EXIT

# Verify pass-cli is available
if ! command -v pass-cli &>/dev/null; then
  echo "::error::pass-cli not found in PATH. Ensure the install step completed successfully."
  exit 1
fi

# Read pass-cli's captured stderr with newlines collapsed to spaces.
read_stderr() {
  local detail
  detail=$(<"$STDERR_FILE")
  printf '%s' "${detail//$'\n'/ }"
}

print_hints() {
  local detail="$1" vault="$2" item="$3" field="$4"
  case "$detail" in
    *"vault by name"*|*"Could not find vault"*)
      echo "::${ANNOTATE}::Hint: the PAT does not have access to vault '$vault'."
      echo "::${ANNOTATE}::  Check current scope: pass-cli pat access list-access --pat-name <YOUR-PAT-NAME>"
      echo "::${ANNOTATE}::  Grant access:        pass-cli pat access grant --pat-name <YOUR-PAT-NAME> --vault-name '$vault' --role viewer"
      ;;
    *"item by name"*|*"Could not find item"*)
      echo "::${ANNOTATE}::Hint: item '$item' was not found in vault '$vault'. List exact names with:"
      echo "::${ANNOTATE}::  pass-cli item list '$vault'"
      ;;
    *"Could not find field"*|*"finding field"*)
      echo "::${ANNOTATE}::Hint: field '$field' was not found on item '$item'. See available fields with:"
      echo "::${ANNOTATE}::  pass-cli item view \"pass://$vault/$item\""
      ;;
  esac
}

# Sanitize a field name into an uppercase env-var suffix.
# Non-alphanumeric -> _, runs collapsed, leading/trailing _ stripped, uppercased.
sanitize_suffix() {
  local raw="$1"
  local out
  out=$(printf '%s' "$raw" | tr -c '[:alnum:]' '_' | tr -s '_' | sed 's/^_//;s/_$//')
  printf '%s' "$out" | tr '[:lower:]' '[:upper:]'
}

# Run pass-cli item view for one (vault, item, field) and append to GITHUB_ENV.
# Updates RESOLVED_COUNT / FAILURES in the caller's scope.
resolve_and_export() {
  local env_key="$1" vault="$2" item="$3" field="$4"
  local resolved error_detail
  echo "  Resolving pass://$vault/$item/$field -> $env_key"

  # </dev/null: callers run this inside while-read loops; don't let pass-cli
  # consume the loop's stdin.
  if ! resolved=$(pass-cli item view "pass://${vault}/${item}/${field}" </dev/null 2>"$STDERR_FILE"); then
    error_detail=$(read_stderr)
    echo "::${ANNOTATE}::Failed to resolve secret for $env_key (pass://$vault/$item/$field): $error_detail"
    print_hints "$error_detail" "$vault" "$item" "$field"
    FAILURES+=("$env_key -> pass://$vault/$item/$field ($error_detail)")
    return 1
  fi

  if [[ "${MASK_VALUES:-true}" == "true" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && echo "::add-mask::$line"
    done <<< "$resolved"
  fi

  local delimiter
  delimiter="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    echo "${env_key}<<${delimiter}"
    echo "${resolved}"
    echo "${delimiter}"
  } >> "$GITHUB_ENV"

  RESOLVED_COUNT=$((RESOLVED_COUNT + 1))
  RESOLVED_KEYS+=("$env_key")
}

# Publish the resolved-keys step output: sorted, comma-separated env var names.
# Names only — values never leave GITHUB_ENV. Empty string when nothing resolved.
write_resolved_keys_output() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  local sorted_keys=""
  # Length guard: expanding an empty array trips set -u on bash 3.2 (macOS).
  if [[ ${#RESOLVED_KEYS[@]} -gt 0 ]]; then
    sorted_keys=$(printf '%s\n' "${RESOLVED_KEYS[@]}" | sort | paste -sd, -)
  fi
  echo "resolved-keys=${sorted_keys}" >> "$GITHUB_OUTPUT"
}

# Parse field names from `pass-cli item view <pass://V/item> --output json`.
# Expected schema: { "fields": [ { "name": "<field>", ... }, ... ] }
# Isolated here so it's a single edit point if Proton's schema differs.
extract_field_names() {
  local item_json="$1"
  printf '%s' "$item_json" | jq -r '.fields[]?.name // empty'
}

# Handle pass://V/item/* — expand into one env var per field on the item.
handle_field_glob() {
  local env_key="$1" vault="$2" item="$3"

  if ! command -v jq &>/dev/null; then
    echo "::${ANNOTATE}::jq is required to expand glob URIs but was not found in PATH."
    echo "::${ANNOTATE}::  Install on ubuntu: sudo apt-get install -y jq"
    echo "::${ANNOTATE}::  Install on macOS:  brew install jq"
    FAILURES+=("$env_key -> pass://$vault/$item/* (jq not found in PATH)")
    return 1
  fi

  local item_json error_detail
  if ! item_json=$(pass-cli item view "pass://${vault}/${item}" --output json </dev/null 2>"$STDERR_FILE"); then
    error_detail=$(read_stderr)
    echo "::${ANNOTATE}::Failed to list fields for pass://$vault/$item: $error_detail"
    FAILURES+=("$env_key -> pass://$vault/$item/* ($error_detail)")
    return 1
  fi

  local field_names
  field_names=$(extract_field_names "$item_json")

  if [[ -z "$field_names" ]]; then
    echo "::${ANNOTATE}::Glob pass://$vault/$item/* matched zero fields on item '$item' in vault '$vault'"
    FAILURES+=("$env_key -> pass://$vault/$item/* (matched zero fields)")
    return 1
  fi

  # Collision detection via a temp file of "<sanitized>\t<raw>" pairs.
  local pairs_file
  pairs_file=$(mktemp)
  while IFS= read -r field_name; do
    [[ -z "$field_name" ]] && continue
    local sanitized
    sanitized=$(sanitize_suffix "$field_name")
    if [[ -z "$sanitized" ]]; then
      echo "::${ANNOTATE}::Field name '$field_name' on item '$item' sanitizes to an empty suffix; rename the field or use an explicit pass:// URI."
      FAILURES+=("$env_key -> pass://$vault/$item/* (field '$field_name' sanitizes to an empty suffix)")
      rm -f "$pairs_file"
      return 1
    fi
    printf '%s\t%s\n' "$sanitized" "$field_name" >> "$pairs_file"
  done <<< "$field_names"

  # Look for any sanitized suffix that appears more than once.
  local collisions
  collisions=$(cut -f1 "$pairs_file" | sort | uniq -d)
  if [[ -n "$collisions" ]]; then
    echo "::${ANNOTATE}::Field-name collision while expanding pass://$vault/$item/*: multiple fields sanitize to the same env-var suffix."
    while IFS= read -r dup; do
      local raw_names
      raw_names=$(awk -F'\t' -v k="$dup" '$1==k {print $2}' "$pairs_file" | paste -sd ',' -)
      echo "::${ANNOTATE}::  ${env_key}_${dup} <- ${raw_names}"
    done <<< "$collisions"
    echo "::${ANNOTATE}::Rename the offending fields or replace the glob with explicit pass:// URIs."
    FAILURES+=("$env_key -> pass://$vault/$item/* (field-name collision)")
    rm -f "$pairs_file"
    return 1
  fi

  # No collisions — resolve each field.
  while IFS=$'\t' read -r sanitized field_name; do
    [[ -z "$sanitized" ]] && continue
    resolve_and_export "${env_key}_${sanitized}" "$vault" "$item" "$field_name" || true
  done < "$pairs_file"

  rm -f "$pairs_file"
}

while IFS='=' read -r key value; do
  [[ -z "$key" ]] && continue
  if [[ ! "$value" =~ $PASS_URI_PATTERN ]]; then
    continue
  fi

  vault="${BASH_REMATCH[1]}"
  item="${BASH_REMATCH[2]}"
  field="${BASH_REMATCH[3]}"

  echo "::group::Resolving $key"
  echo "  URI: pass://$vault/$item/$field"

  # Reject wildcards in vault or item segments; only field segment may be `*`.
  if [[ "$vault" == *"*"* || "$item" == *"*"* ]]; then
    echo "::${ANNOTATE}::Wildcards are only supported in the field segment. Got '$value'."
    echo "::${ANNOTATE}::  Supported form: pass://Vault/Item/*"
    FAILURES+=("$key -> $value (wildcards only supported in the field segment)")
    echo "::endgroup::"
    continue
  fi

  if [[ "$field" == "*" ]]; then
    handle_field_glob "$key" "$vault" "$item" || true
  elif [[ "$field" == *"*"* ]]; then
    # A `*` mixed into a field name would otherwise fail as a literal lookup.
    echo "::${ANNOTATE}::Partial wildcards are not supported in the field segment. Got '$value'."
    echo "::${ANNOTATE}::  Use pass://Vault/Item/* to load every field, or an exact field name."
    FAILURES+=("$key -> $value (partial wildcards not supported)")
  else
    resolve_and_export "$key" "$vault" "$item" "$field" || true
  fi

  echo "::endgroup::"
done < <(env)

# Before the strict-mode exit so downstream `if: always()` steps can inspect it.
write_resolved_keys_output

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "::${ANNOTATE}::Failed to resolve ${#FAILURES[@]} secret(s):"
  for failure in "${FAILURES[@]}"; do
    echo "::${ANNOTATE}::  $failure"
  done
  if [[ "$STRICT" == "true" ]]; then
    exit 1
  fi
  echo "Continuing despite ${#FAILURES[@]} unresolved secret(s) (strict=false)"
fi

echo "Resolved $RESOLVED_COUNT secret(s) from Proton Pass"
