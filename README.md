# nekoclaw 🐾

**nekoclaw** is a multi-agent chat runtime designed to bring autonomous AI agents into real-world chat platforms like Telegram and QQ (via NapCat/OneBot). Built on top of `@mariozechner/pi-coding-agent`, it provides a robust, daemon-managed environment where agents live in isolated Docker containers, equipped with their own personalities, memories, and specialized skills.

---

## ✨ Key Features

- **Multi-Agent Runtime**: Run and manage multiple independent agents from a single background daemon.
- **Platform Integration**: Native support for **Telegram** (via `grammy`) and **QQ/OneBot** (via `napcat`).
- **Secure Isolation**: Each agent runs in its own **Docker container**, ensuring file system isolation and resource control.
- **Rich Personalities**: Define agents using `SOUL.md` (voice/personality) and `MEMORY.md` (long-term facts).
- **Extensible Skills**: Add specialized capabilities (shell access, file editing, custom tools) via a modular skill system.
- **Model Agnostic**: Support for a wide range of providers, including:
  - **Global**: OpenAI, Anthropic, Google (Gemini), Groq, Cerebras, xAI, OpenRouter, Mistral, Hugging Face.
  - **Regional/Specialized**: Minimax, Minimax-CN, Kimi (Moonshot), OpenCode, ZAI.
  - **Custom**: Any OpenAI-compatible endpoint (vLLM, Ollama, etc.) with configurable base URLs.
- **Smart Routing**: Handles group chat mentions, explicit replies, and private DMs with configurable trigger modes.
- **Advanced Chat Tools**: Agents can edit/delete their own messages, show typing indicators, and suppress replies when appropriate.

---

## 🏗️ Architecture

```text
  [ Users ] <--> [ Platforms ] <--> [ nekoclaw Daemon ]
                                          |
      +-----------------------------------+-----------------------------------+
      |                                   |                                   |
[ Agent A (Docker) ]               [ Agent B (Docker) ]               [ Agent C (Docker) ]
  - SOUL.md                          - SOUL.md                          - SOUL.md
  - MEMORY.md                        - MEMORY.md                        - MEMORY.md
  - skills/                          - skills/                          - skills/
  - chats/ (Sessions)                - chats/ (Sessions)                - chats/ (Sessions)
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js**: >= 20.6.0
- **Docker**: Installed and running (required for agent isolation).
- **Git**: For cloning and management.

### One-Step Interactive Install

On macOS or Linux (`x64` and `arm64`), run the following command to bootstrap your first agent:

```bash
./install.sh
```

The interactive installer will:
1. Check for `node`, `npm`, and `docker`.
2. Install dependencies and build the project.
3. Guide you through creating an agent (Name, Model, API Key, Telegram Token).
4. Start the background daemon and enable your agent.

**Prefilling values with flags:**
```bash
./install.sh --name cat-agent --source builtin --provider anthropic --model claude-3-5-sonnet-20240620 --api-key <key> --token <telegram-bot-token>
```

---

## 🧠 Core Concepts

### Agents
An agent is a distinct AI entity. Its behavior is defined in its workspace directory (usually `~/.nekoclaw/workspaces/<slug>`):
- **`SOUL.md`**: The primary system prompt describing the agent's persona, tone, and constraints.
- **`MEMORY.md`**: A durable storage for facts, user preferences, and long-term state.
- **`skills/`**: A folder containing modular tools and procedural knowledge.
- **`chats/`**: Isolated session data, including message history and file attachments.

### Channels
Channels connect agents to the outside world.
- **Telegram**: Uses a Bot Token. Supports DMs and Groups.
- **NapCat**: Connects to a NapCat/OneBot11 WebSocket endpoint for QQ integration.

### The Daemon
The `nekoclaw` daemon runs in the background, managing:
- Connection persistence for all active channels.
- Inbound message routing and job queuing.
- Lifecycle management of agent Docker containers.
- Outbound message dispatching.

---

## 🛠️ CLI Reference

The `nekoclaw` CLI is the primary way to interact with the runtime.

### Daemon Management
- `nekoclaw start`: Start the background runtime daemon.
- `nekoclaw stop`: Stop the background daemon and all active agents.
- `nekoclaw restart`: Restart the daemon.
- `nekoclaw status`: Show daemon health and a summary of all agents.

### Agent Management
- `nekoclaw agent create <name>`: Create a new agent workspace.
- `nekoclaw agent list`: List all agents and their current state.
- `nekoclaw agent enable/disable <agent>`: Toggle an agent's online status.
- `nekoclaw agent remove <agent>`: Delete an agent and its configuration.
- `nekoclaw doctor [agent]`: Run diagnostics on configuration and connectivity.

### Configuration
- **Model**: `nekoclaw model set/list/current <agent>`
- **Channels**: `nekoclaw channel add/remove/list/token <agent>`
- **Admins**: `nekoclaw admin add/remove/list <agent>` (Bind platform users as agent admins)
- **Sessions**: `nekoclaw session list/remove <agent>`

### Pairing
When a new user messsages a group where the agent is present, they may need to "pair" to start a private session.
- `nekoclaw pair list`: View pending pairing requests.
- `nekoclaw pair accept --code <code>`: Approve a request.

---

## 🛠️ Development

```bash
# Clone the repository
git clone https://github.com/your-repo/nekoclaw.git
cd nekoclaw

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Run the CLI locally
node dist/cli.js --help
```

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
