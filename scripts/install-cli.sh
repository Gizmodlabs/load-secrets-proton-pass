#!/usr/bin/env bash
set -euo pipefail

VERSION="${PASS_CLI_VERSION:-latest}"

# Skip if a matching pass-cli is already on PATH (lets tests preinstall a mock)
if command -v pass-cli &>/dev/null; then
  INSTALLED_VERSION=$(pass-cli --version 2>/dev/null || echo "unknown")
  if [[ "$VERSION" == "latest" || "$INSTALLED_VERSION" == *"$VERSION"* ]]; then
    echo "pass-cli already installed: $INSTALLED_VERSION"
    exit 0
  fi
  echo "Installed version ($INSTALLED_VERSION) does not match requested ($VERSION), reinstalling..."
fi

# Detect OS and architecture, mapping to Proton's release naming
# (see https://proton.me/download/pass-cli/versions.json)
OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH_RAW=$(uname -m)

case "$OS_RAW" in
  linux)  OS="linux" ;;
  darwin) OS="macos" ;;
  *)
    echo "::error::Unsupported OS: $OS_RAW"
    exit 1
    ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64)     ARCH="x86_64" ;;
  aarch64|arm64)    ARCH="aarch64" ;;
  *)
    echo "::error::Unsupported architecture: $ARCH_RAW"
    exit 1
    ;;
esac

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "$INSTALL_DIR"

if [[ "$VERSION" == "latest" ]]; then
  echo "Installing latest pass-cli via official install script..."
  curl -fsSL https://proton.me/download/pass-cli/install.sh | bash
else
  echo "Installing pass-cli version $VERSION for $OS/$ARCH..."
  DOWNLOAD_URL="https://proton.me/download/pass-cli/${VERSION}/pass-cli-${OS}-${ARCH}"

  # Download the binary
  curl -fsSL -o "${INSTALL_DIR}/pass-cli" "$DOWNLOAD_URL" || {
    echo "::error::Download failed for $DOWNLOAD_URL"
    echo "::error::Confirm the version exists in https://proton.me/download/pass-cli/versions.json"
    exit 1
  }
  chmod +x "${INSTALL_DIR}/pass-cli"

  # Verify SHA-256 against versions.json
  VERSIONS_JSON=$(curl -fsSL "https://proton.me/download/pass-cli/versions.json" 2>/dev/null || echo "")
  if [[ -n "$VERSIONS_JSON" ]]; then
    # JSON shape: passCliVersions.urls.<os>.<arch>.{url,hash}
    # Find the line with our exact URL, then grab the hash within the next 3 lines.
    EXPECTED_SHA=$(printf '%s\n' "$VERSIONS_JSON" \
      | grep -A 3 -F "\"$DOWNLOAD_URL\"" \
      | grep -m 1 '"hash"' \
      | sed -E 's/.*"hash"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' \
      || echo "")
    if [[ -n "$EXPECTED_SHA" ]]; then
      if command -v sha256sum &>/dev/null; then
        ACTUAL_SHA=$(sha256sum "${INSTALL_DIR}/pass-cli" | awk '{print $1}')
      else
        ACTUAL_SHA=$(shasum -a 256 "${INSTALL_DIR}/pass-cli" | awk '{print $1}')
      fi
      if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
        echo "::error::SHA-256 checksum mismatch! Expected: $EXPECTED_SHA, Got: $ACTUAL_SHA"
        rm -f "${INSTALL_DIR}/pass-cli"
        exit 1
      fi
      echo "SHA-256 checksum verified"
    else
      echo "::warning::Could not find SHA-256 for $DOWNLOAD_URL in versions.json (skipping verification)"
    fi
  fi
fi

# Add to PATH for subsequent steps and the current step
export PATH="${INSTALL_DIR}:$PATH"
echo "${INSTALL_DIR}" >> "$GITHUB_PATH"

# Print installed version
INSTALLED_VERSION=$(pass-cli --version 2>/dev/null || echo "unknown")
echo "pass-cli installed: $INSTALLED_VERSION"
