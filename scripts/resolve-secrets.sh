#!/usr/bin/env bash
set -euo pipefail

PASS_URI_PATTERN="^pass://(.+)/(.+)/(.+)$"
RESOLVED_COUNT=0
FAILED=0

# Verify pass-cli is available
if ! command -v pass-cli &>/dev/null; then
  echo "::error::pass-cli not found in PATH. Ensure the install step completed successfully."
  exit 1
fi

# Sanitize a field name into an uppercase env-var suffix.
# Non-alphanumeric -> _, runs collapsed, leading/trailing _ stripped, uppercased.
sanitize_suffix() {
  local raw="$1"
  local out
  out=$(printf '%s' "$raw" | tr -c '[:alnum:]' '_' | tr -s '_' | sed 's/^_//;s/_$//')
  printf '%s' "$out" | tr '[:lower:]' '[:upper:]'
}

# Run pass-cli item view for one (vault, item, field) and append to GITHUB_ENV.
# Updates RESOLVED_COUNT / FAILED in the caller's scope.
resolve_and_export() {
  local env_key="$1" vault="$2" item="$3" field="$4"
  local resolved
  echo "  Resolving pass://$vault/$item/$field -> $env_key"

  if ! resolved=$(pass-cli item view "pass://${vault}/${item}/${field}" 2>&1); then
    echo "::error::Failed to resolve secret for $env_key (pass://$vault/$item/$field): $resolved"
    case "$resolved" in
      *"vault by name"*|*"Could not find vault"*)
        echo "::error::Hint: the PAT does not have access to vault '$vault'."
        echo "::error::  Check current scope: pass-cli pat access list-access --pat-name <YOUR-PAT-NAME>"
        echo "::error::  Grant access:        pass-cli pat access grant --pat-name <YOUR-PAT-NAME> --vault-name '$vault' --role viewer"
        ;;
      *"item by name"*|*"Could not find item"*)
        echo "::error::Hint: item '$item' was not found in vault '$vault'. List exact names with:"
        echo "::error::  pass-cli item list '$vault'"
        ;;
      *"Could not find field"*|*"finding field"*)
        echo "::error::Hint: field '$field' was not found on item '$item'. See available fields with:"
        echo "::error::  pass-cli item view \"pass://$vault/$item\""
        ;;
    esac
    FAILED=$((FAILED + 1))
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
    echo "::error::jq is required to expand glob URIs but was not found in PATH."
    echo "::error::  Install on ubuntu: sudo apt-get install -y jq"
    echo "::error::  Install on macOS:  brew install jq"
    FAILED=$((FAILED + 1))
    return 1
  fi

  local item_json
  if ! item_json=$(pass-cli item view "pass://${vault}/${item}" --output json 2>&1); then
    echo "::error::Failed to list fields for pass://$vault/$item: $item_json"
    FAILED=$((FAILED + 1))
    return 1
  fi

  local field_names
  field_names=$(extract_field_names "$item_json")

  if [[ -z "$field_names" ]]; then
    echo "::error::Glob pass://$vault/$item/* matched zero fields on item '$item' in vault '$vault'"
    FAILED=$((FAILED + 1))
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
      echo "::error::Field name '$field_name' on item '$item' sanitizes to an empty suffix; rename the field or use an explicit pass:// URI."
      FAILED=$((FAILED + 1))
      rm -f "$pairs_file"
      return 1
    fi
    printf '%s\t%s\n' "$sanitized" "$field_name" >> "$pairs_file"
  done <<< "$field_names"

  # Look for any sanitized suffix that appears more than once.
  local collisions
  collisions=$(cut -f1 "$pairs_file" | sort | uniq -d)
  if [[ -n "$collisions" ]]; then
    echo "::error::Field-name collision while expanding pass://$vault/$item/*: multiple fields sanitize to the same env-var suffix."
    while IFS= read -r dup; do
      local raw_names
      raw_names=$(awk -F'\t' -v k="$dup" '$1==k {print $2}' "$pairs_file" | paste -sd ',' -)
      echo "::error::  ${env_key}_${dup} <- ${raw_names}"
    done <<< "$collisions"
    echo "::error::Rename the offending fields or replace the glob with explicit pass:// URIs."
    FAILED=$((FAILED + 1))
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
    echo "::error::Wildcards are only supported in the field segment. Got '$value'."
    echo "::error::  Supported form: pass://Vault/Item/*"
    FAILED=$((FAILED + 1))
    echo "::endgroup::"
    continue
  fi

  if [[ "$field" == "*" ]]; then
    handle_field_glob "$key" "$vault" "$item" || true
  else
    resolve_and_export "$key" "$vault" "$item" "$field" || true
  fi

  echo "::endgroup::"
done < <(env)

if [[ "$FAILED" -gt 0 ]]; then
  echo "::error::Failed to resolve $FAILED secret(s)"
  exit 1
fi

echo "Resolved $RESOLVED_COUNT secret(s) from Proton Pass"
