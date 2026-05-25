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

while IFS='=' read -r key value; do
  # Skip empty keys or internal vars
  [[ -z "$key" ]] && continue

  # Skip non-pass:// values
  if [[ ! "$value" =~ $PASS_URI_PATTERN ]]; then
    continue
  fi

  vault="${BASH_REMATCH[1]}"
  item="${BASH_REMATCH[2]}"
  field="${BASH_REMATCH[3]}"

  echo "::group::Resolving $key"
  echo "  URI: pass://$vault/$item/$field"

  # Resolve using pass-cli item view (accepts pass:// URIs directly)
  resolved=$(pass-cli item view "pass://${vault}/${item}/${field}" 2>&1) || {
    echo "::error::Failed to resolve secret for $key (pass://$vault/$item/$field): $resolved"
    case "$resolved" in
      *"vault by name"*|*"Could not find vault"*)
        echo "::error::Hint: the PAT does not have access to vault '$vault'."
        echo "::error::  Check current scope: pass-cli pat access list-access --pat-name <YOUR-PAT-NAME>"
        echo "::error::  Grant access:        pass-cli pat access grant --pat-name <YOUR-PAT-NAME> --vault-name '$vault' --role viewer"
        ;;
      *"item by name"*|*"Could not find item"*)
        echo "::error::Hint: item '$item' was not found in vault '$vault'. List exact names with:"
        echo "::error::  pass-cli item list --vault-name '$vault'"
        ;;
      *"Could not find field"*|*"finding field"*)
        echo "::error::Hint: field '$field' was not found on item '$item'. See available fields with:"
        echo "::error::  pass-cli item view \"pass://$vault/$item\""
        ;;
    esac
    FAILED=$((FAILED + 1))
    echo "::endgroup::"
    continue
  }

  # Mask the value in all subsequent logs
  if [[ "${MASK_VALUES:-true}" == "true" ]]; then
    # Mask each line individually for multiline values (e.g., SSH keys)
    while IFS= read -r line; do
      if [[ -n "$line" ]]; then
        echo "::add-mask::$line"
      fi
    done <<< "$resolved"
  fi

  # Export as env var for subsequent steps, multiline-safe
  delimiter="EOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  {
    echo "${key}<<${delimiter}"
    echo "${resolved}"
    echo "${delimiter}"
  } >> "$GITHUB_ENV"

  RESOLVED_COUNT=$((RESOLVED_COUNT + 1))
  echo "  Resolved successfully"
  echo "::endgroup::"

done < <(env)

if [[ "$FAILED" -gt 0 ]]; then
  echo "::error::Failed to resolve $FAILED secret(s)"
  exit 1
fi

echo "Resolved $RESOLVED_COUNT secret(s) from Proton Pass"
