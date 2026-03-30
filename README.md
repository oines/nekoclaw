# nekoclaw

`nekoclaw` is a standalone multi-agent chat product built on top of `@mariozechner/pi-coding-agent`.

## One-step install

On macOS or Linux (`x64` and `arm64`), run:

```bash
./install.sh
```

The installer is interactive and will ask for:
- agent name
- built-in or custom model source
- provider or custom `provider-id`
- model id
- API key
- Telegram bot token

You can still prefill values with flags:

```bash
./install.sh --name cat-agent --source custom --base-url https://example.com/v1 --provider-id custom-ai --model claude-sonnet-4-6 --api-key <key> --token <bot-token>
```

The installer checks `node`, `npm`, and `docker`, installs dependencies, builds `nekoclaw`, runs `quickstart`, and then automatically enables the agent.

## Core commands

- `nekoclaw quickstart`
- `nekoclaw agent create|list|status|enable|disable|remove`
- `nekoclaw model list|set|current`
- `nekoclaw channel add|remove|list|token`
- `nekoclaw pair list|accept|reject`
- `nekoclaw session list|remove`
- `nekoclaw doctor [agent]`

## Development

```bash
cd nekoclaw
npm run build
npm test
node dist/cli.js --help
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
