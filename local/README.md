# Local Configuration

This directory holds private runtime configuration. Real tokens, passwords,
private keys, runtime state, logs, and generated files are not committed.

## Fresh Install Order

Start with SSH only:

```bash
cp local/connections.json.example local/connections.json
```

Edit `local/connections.json`:

```json
{
  "connections": [
    {
      "name": "ssh-main",
      "type": "ssh",
      "host": "192.168.31.183",
      "port": 22,
      "username": "leon",
      "privateKey": "~/.ssh/id_rsa"
    }
  ],
  "default": "ssh-main"
}
```

Verify SSH:

```bash
node cli.js ssh-health --connection ssh-main --route ssh --json
```

Provision this software's daemon token:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection ssh-main \
  --route ssh \
  --daemon-url http://<host>:3183 \
  --daemon-name daemon-main \
  --local-dir . \
  --json
```

Validate with an authenticated daemon command:

```bash
node cli.js job list --connection daemon-main --route daemon --limit 1 --json
```

## MCP Registration

If the AI tool supports native MCP, also create `local/agentport.json`:

```bash
cp agentport.example.json local/agentport.json
```

Set at least:

| Variable | Purpose |
| --- | --- |
| `skillDir` | Absolute path to this AgentPort skill directory |
| `mcpConfigPath` | Target AI tool MCP config path |
| `mcpServerName` | Usually `agentport` |

Then run:

```bash
node sync.cjs
```

Restart the AI tool after MCP config changes.

## Files

```text
local/
|-- README.md
|-- connections.json
|-- agentport.json
`-- server/
    `-- .env
```

## Safety

- Do not commit real `local/connections.json`, `local/agentport.json`, or
  `local/server/.env`.
- Do not copy another software's daemon `authToken` as the final setup.
- Use one unique `clientId=token` for each machine/software pair.
- Report only masked tokens.
