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

AGENT_NAME=""
MODEL_SOURCE=""
PROVIDER_NAME=""
MODEL_ID=""
BASE_URL=""
PROVIDER_ID=""
API_KEY=""
BOT_TOKEN=""
QUICKSTART_ARGS=()
CUSTOM_SOURCE=0

prompt_value() {
	local label="$1"
	local fallback="${2-}"
	local value=""
	if [[ -n "$fallback" ]]; then
		read -r -p "$label [$fallback]: " value
		printf '%s' "${value:-$fallback}"
		return
	fi
	read -r -p "$label: " value
	printf '%s' "$value"
}

while (($# > 0)); do
	case "$1" in
		--name)
			if (($# < 2)); then
				echo "Missing value for --name" >&2
				exit 1
			fi
			AGENT_NAME="$2"
			shift 2
			;;
		--source)
			if (($# < 2)); then
				echo "Missing value for --source" >&2
				exit 1
			fi
			MODEL_SOURCE="$2"
			if [[ "$2" == "custom" ]]; then
				CUSTOM_SOURCE=1
			fi
			shift 2
			;;
		--provider)
			if (($# < 2)); then
				echo "Missing value for --provider" >&2
				exit 1
			fi
			PROVIDER_NAME="$2"
			shift 2
			;;
		--model)
			if (($# < 2)); then
				echo "Missing value for --model" >&2
				exit 1
			fi
			MODEL_ID="$2"
			shift 2
			;;
		--base-url)
			CUSTOM_SOURCE=1
			if (($# < 2)); then
				echo "Missing value for --base-url" >&2
				exit 1
			fi
			BASE_URL="$2"
			shift 2
			;;
		--provider-id)
			if (($# < 2)); then
				echo "Missing value for --provider-id" >&2
				exit 1
			fi
			PROVIDER_ID="$2"
			shift 2
			;;
		--api-key)
			if (($# < 2)); then
				echo "Missing value for --api-key" >&2
				exit 1
			fi
			API_KEY="$2"
			shift 2
			;;
		--token)
			if (($# < 2)); then
				echo "Missing value for --token" >&2
				exit 1
			fi
			BOT_TOKEN="$2"
			shift 2
			;;
		*)
			QUICKSTART_ARGS+=("$1")
			shift
			;;
	esac
done

if [[ -z "$AGENT_NAME" ]]; then
	AGENT_NAME="$(prompt_value 'Agent name')"
fi

if [[ -z "$AGENT_NAME" ]]; then
	echo "Agent name is required." >&2
	exit 1
fi

if [[ -z "$MODEL_SOURCE" ]]; then
	MODEL_SOURCE="$(prompt_value 'Model source (built-in/custom)' 'built-in')"
fi

if [[ "$MODEL_SOURCE" == "custom" || -n "$BASE_URL" ]]; then
	CUSTOM_SOURCE=1
	MODEL_SOURCE="custom"
else
	MODEL_SOURCE="built-in"
fi

if (( CUSTOM_SOURCE == 1 )); then
	if [[ -z "$BASE_URL" ]]; then
		BASE_URL="$(prompt_value 'Custom model base URL')"
	fi
	if [[ -z "$PROVIDER_ID" ]]; then
		PROVIDER_ID="$(prompt_value 'Custom provider ID')"
	fi
	if [[ -z "$MODEL_ID" ]]; then
		MODEL_ID="$(prompt_value 'Custom model ID')"
	fi
	if [[ -z "$API_KEY" ]]; then
		API_KEY="$(prompt_value 'Custom model API key (leave empty if none)')"
	fi
else
	if [[ -z "$PROVIDER_NAME" ]]; then
		PROVIDER_NAME="$(prompt_value 'Built-in provider' 'openai')"
	fi
	if [[ -z "$MODEL_ID" ]]; then
		MODEL_ID="$(prompt_value 'Built-in model ID' 'gpt-5')"
	fi
	if [[ -z "$API_KEY" ]]; then
		API_KEY="$(prompt_value 'Provider API key (leave empty if none)')"
	fi
fi

if [[ -z "$BOT_TOKEN" ]]; then
	BOT_TOKEN="$(prompt_value 'Telegram bot token')"
fi

if (( CUSTOM_SOURCE == 1 )) && [[ -z "$PROVIDER_ID" ]]; then
	echo "Custom model setup requires a provider ID." >&2
	exit 1
fi

QUICKSTART_ARGS=(--name "$AGENT_NAME" --source "$MODEL_SOURCE")
if (( CUSTOM_SOURCE == 1 )); then
	QUICKSTART_ARGS+=(--base-url "$BASE_URL" --provider-id "$PROVIDER_ID" --model "$MODEL_ID")
else
	QUICKSTART_ARGS+=(--provider "$PROVIDER_NAME" --model "$MODEL_ID")
fi
if [[ -n "$API_KEY" ]]; then
	QUICKSTART_ARGS+=(--api-key "$API_KEY")
fi
if [[ -n "$BOT_TOKEN" ]]; then
	QUICKSTART_ARGS+=(--token "$BOT_TOKEN")
fi

echo "Installing nekoclaw on $OS/$PLATFORM_ARCH"

cd "$PROJECT_DIR"
npm install
npm run build

LAUNCHER="$PROJECT_DIR/dist/cli.js"
if npm link >/dev/null 2>&1 && command -v nekoclaw >/dev/null 2>&1; then
	LAUNCHER="nekoclaw"
fi

echo "Running quickstart"
"$LAUNCHER" quickstart "${QUICKSTART_ARGS[@]}"

echo "Enabling agent $AGENT_NAME"
"$LAUNCHER" agent enable "$AGENT_NAME"

echo "nekoclaw is installed and $AGENT_NAME is enabled."
