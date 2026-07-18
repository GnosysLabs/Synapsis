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

Credentials are stored in `~/.config/synapsis/credentials.json` with owner-only permissions. Set `SYNAPSIS_CONFIG_DIR` to use a different location. Revoke a device from Synapsis Settings → CLI & Agents or run `synapsis auth disconnect`.
