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
    # Only `item view <pass://uri>` is exercised by the action.
    if [[ "$2" != "view" ]]; then
      echo "Unknown item subcommand: $2" >&2
      exit 1
    fi
    URI="$3"
    case "$URI" in
      *GithubActions*load-secrets-proton-pass-test*Password*)
        echo "mock-real-password"
        ;;
      *GithubActions*load-secrets-proton-pass-test*Email*)
        echo "mock@example.com"
        ;;
      *)
        echo "mock-secret-value"
        ;;
    esac
    exit 0
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
