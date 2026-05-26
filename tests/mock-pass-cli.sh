#!/usr/bin/env bash
# Mock pass-cli for offline testing
# Returns deterministic values based on command and arguments

case "$1" in
  login)
    echo "Login successful (mock)"
    exit 0
    ;;
  test)
    echo "Session is valid (mock)"
    exit 0
    ;;
  info)
    echo "Personal Access Token: github-actions (mock)"
    exit 0
    ;;
  item)
    if [[ "$2" == "view" ]]; then
      URI=""
      OUTPUT="human"
      shift 2 # consume "item view"
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --output) OUTPUT="$2"; shift ;;
          pass://*) URI="$1" ;;
        esac
        shift
      done

      # Field-glob path: `pass-cli item view pass://V/item --output json` (no field).
      # Recognized by absence of a trailing /<field> and OUTPUT=json.
      if [[ "$OUTPUT" == "json" ]]; then
        case "$URI" in
          *GithubActions/multi-field-item)
            cat <<'JSON'
{"title":"multi-field-item","fields":[{"name":"host","value":"db.example.com"},{"name":"port","value":"5432"},{"name":"password","value":"hunter2"}]}
JSON
            ;;
          *GithubActions/empty-item)
            echo '{"title":"empty-item","fields":[]}'
            ;;
          *GithubActions/collision-item)
            cat <<'JSON'
{"title":"collision-item","fields":[{"name":"api-key","value":"a"},{"name":"api_key","value":"b"}]}
JSON
            ;;
          *)
            echo '{"title":"unknown","fields":[]}'
            ;;
        esac
        exit 0
      fi

      # Single-field path: `pass-cli item view pass://V/item/field`.
      case "$URI" in
        *GithubActions/load-secrets-proton-pass-test/Password)
          echo "mock-real-password"
          ;;
        *GithubActions/load-secrets-proton-pass-test/Email)
          echo "mock@example.com"
          ;;
        *GithubActions/multi-field-item/host)
          echo "db.example.com"
          ;;
        *GithubActions/multi-field-item/port)
          echo "5432"
          ;;
        *GithubActions/multi-field-item/password)
          echo "hunter2"
          ;;
        *)
          echo "mock-secret-value"
          ;;
      esac
      exit 0
    fi
    echo "Unknown item subcommand: $2" >&2
    exit 1
    ;;
  inject)
    # Simulate template injection: replace {{ pass://... }} with mock values
    TEMPLATE=""
    OUTPUT=""
    shift  # consume "inject"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -i) TEMPLATE="$2"; shift ;;
        -o) OUTPUT="$2"; shift ;;
      esac
      shift
    done
    if [[ -n "$OUTPUT" && -n "$TEMPLATE" && -f "$TEMPLATE" ]]; then
      sed -E 's/\{\{ *pass:\/\/[^}]+ *\}\}/mock-injected-value/g' "$TEMPLATE" > "$OUTPUT"
    fi
    exit 0
    ;;
  logout)
    echo "Logged out (mock)"
    exit 0
    ;;
  --version)
    echo "pass-cli 1.0.0 (mock)"
    exit 0
    ;;
  *)
    echo "Unknown command: $1" >&2
    exit 1
    ;;
esac
