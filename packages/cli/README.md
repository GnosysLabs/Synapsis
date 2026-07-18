# Synapsis CLI

Publish text and media to a Synapsis account without giving an agent your password or account identity key.

## Install

```bash
npm install --global @gnosyslabs/synapsis-cli
```

Connect a node. The command opens a browser where the signed-in user approves a revocable device key:

```bash
synapsis auth connect https://social.example
```

Run the connect command for every account and node you want available. A custom `--profile` alias is optional; without one, the CLI identifies each connection internally as `username@node-hostname`.

```bash
synapsis auth connect https://one.example
synapsis auth connect https://two.example
synapsis auth status
```

The bundled agent skill lets users select an account naturally by username. If a username exists on multiple nodes, or the user does not identify an account when several are connected, the agent asks which destination to use before posting.

Publish text:

```bash
synapsis post create --text "Hello from the Synapsis CLI"
```

Publish media with optional alt text:

```bash
synapsis post create \
  --text "A field recording" \
  --media ./cover.jpg --alt "Album cover at sunset" \
  --media ./recording.flac
```

Use stdin and machine-readable output from an agent:

```bash
printf '%s' "A post composed by an agent" | synapsis post create --stdin --json
```

Install the bundled skill for Codex, Agent Skills-compatible clients, and Claude Code:

```bash
synapsis skill install
```

By default this installs `synapsis-post` under `~/.codex/skills`, `~/.agents/skills`, and `~/.claude/skills`. Use `--path <skills-directory>` for a custom single destination, or `--force` to replace existing copies.

Update the global CLI to the latest npm release and refresh the bundled skill in all three default locations:

```bash
synapsis update
```

Credentials are stored in `~/.config/synapsis/credentials.json` with owner-only permissions. Set `SYNAPSIS_CONFIG_DIR` to use a different location. Revoke a device from Synapsis Settings → CLI & Agents or run `synapsis auth disconnect`.
