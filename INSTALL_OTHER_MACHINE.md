# Install On Another Machine Or AI Software

Use this flow when a new AI desktop tool, a new Windows account, or another
computer needs AgentPort access to an existing remote daemon.

## Rule

Each machine/software pair must have its own local `local/` directory and its
own remote `clientId=token`.

Do not use junctions for different AI tools when their credentials should be
separate. Do not copy another software's daemon `authToken` as the final setup.

## Standard Flow

```bash
git clone https://github.com/knownothing20/agentport.git
cd agentport
npm install
```

Create or copy only an SSH connection template in `local/connections.json`.
Then verify the SSH baseline:

```bash
node cli.js ssh-health --connection <ssh-connection> --route ssh --json
```

Provision this software's daemon token:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection <ssh-connection> \
  --route ssh \
  --daemon-url http://<host>:3183 \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
```

Validate the new daemon connection:

```bash
node cli.js job list --connection <machine-software-daemon> --route daemon --limit 1 --json
```

The provision command creates or reuses the remote token, writes this
software's local `local/connections.json`, and prints only `tokenMasked`.

## If You Already Have An Admin Daemon Connection

You can provision through the daemon route and hot-reload config:

```bash
node cli.js client provision \
  --client-id <machine-software> \
  --connection <admin-daemon-connection> \
  --route daemon \
  --daemon-name <machine-software-daemon> \
  --local-dir <skill-dir> \
  --json
```

If verification is unauthorized after SSH provisioning, reload or restart the
remote daemon and run provision again. The command should end with
`verification.ok: true`.

## Sync Local Skill Copies

From the maintained repository copy, sync code to independent skill
directories while preserving each target's `local/`, `.git`, and `node_modules`:

```bash
node sync.cjs --skills --target <skill-dir-1> --target <skill-dir-2>
node sync.cjs --check --skills --target <skill-dir-1> --target <skill-dir-2>
```

You can also put target directories in
`local/agentport.json -> variables.skillTargets`.
