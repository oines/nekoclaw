#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
	Darwin|Linux) ;;
	*)
		echo "Unsupported OS: $OS. This installer supports macOS and Linux only." >&2
		exit 1
		;;
esac

case "$ARCH" in
	x86_64|amd64) PLATFORM_ARCH="x64" ;;
	arm64|aarch64) PLATFORM_ARCH="arm64" ;;
	*)
		echo "Unsupported architecture: $ARCH. This installer supports x64 and arm64 only." >&2
		exit 1
		;;
esac

require_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "Missing required command: $1" >&2
		exit 1
	fi
}

require_command node
require_command npm
require_command docker

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 6) ? 0 : 1)'; then
	echo "Node.js >= 20.6.0 is required." >&2
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	echo "Docker is installed but not available. Start Docker and run this installer again." >&2
	exit 1
fi

echo "Installing nekoclaw on $OS/$PLATFORM_ARCH"

cd "$PROJECT_DIR"
npm install
npm run build

LAUNCHER="$PROJECT_DIR/dist/cli.js"
if npm link >/dev/null 2>&1 && command -v nekoclaw >/dev/null 2>&1; then
	LAUNCHER="nekoclaw"
fi

echo "Starting interactive setup"
node "$PROJECT_DIR/dist/cli.js" quickstart "$@"
