#!/usr/bin/env bash
set -euo pipefail

TEMPLATE="${ENV_TEMPLATE:?ENV_TEMPLATE must be set}"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "::error::Template file not found: $TEMPLATE"
  exit 1
fi

# Determine output path: use explicit override, strip .template suffix, or append .resolved
if [[ -n "${OUTPUT_PATH:-}" ]]; then
  OUTPUT="$OUTPUT_PATH"
elif [[ "$TEMPLATE" == *.template ]]; then
  OUTPUT="${TEMPLATE%.template}"
elif [[ "$TEMPLATE" == *.tpl ]]; then
  OUTPUT="${TEMPLATE%.tpl}"
else
  OUTPUT="${TEMPLATE}.resolved"
fi

echo "Injecting secrets into template: $TEMPLATE -> $OUTPUT"

# Use pass-cli inject to resolve {{ pass://vault/item/field }} references
inject_err=$(pass-cli inject -i "$TEMPLATE" -o "$OUTPUT" 2>&1) || {
  echo "::error::Failed to inject secrets into template: $TEMPLATE"
  echo "::error::$inject_err"
  case "$inject_err" in
    *"vault by name"*|*"Could not find vault"*)
      echo "::error::Hint: the PAT does not have access to a vault referenced in the template."
      echo "::error::  Check current scope: pass-cli pat access list-access --pat-name <YOUR-PAT-NAME>"
      echo "::error::  Grant access:        pass-cli pat access grant --pat-name <YOUR-PAT-NAME> --vault-name '<VAULT>' --role viewer"
      ;;
    *"item by name"*|*"Could not find item"*)
      echo "::error::Hint: an item in the template was not found. List items per vault:"
      echo "::error::  pass-cli item list --vault-name '<VAULT>'"
      ;;
    *"Could not find field"*|*"finding field"*)
      echo "::error::Hint: a field reference in the template is wrong. View the item to see available fields:"
      echo "::error::  pass-cli item view \"pass://<vault>/<item>\""
      ;;
  esac
  exit 1
}

# Mask only values that were injected (lines that had pass:// in the template)
if [[ "${MASK_VALUES:-true}" == "true" ]]; then
  while IFS= read -r template_line; do
    if [[ "$template_line" == *"pass://"* ]]; then
      # Extract the key from this template line
      tmpl_key="${template_line%%=*}"
      # Find the corresponding resolved value in the output
      while IFS='=' read -r out_key out_value; do
        if [[ "$out_key" == "$tmpl_key" && -n "$out_value" ]]; then
          echo "::add-mask::$out_value"
          break
        fi
      done < "$OUTPUT"
    fi
  done < "$TEMPLATE"
fi

echo "Template injection complete: $OUTPUT"
