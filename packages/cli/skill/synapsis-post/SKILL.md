---
name: synapsis-post
description: Publish text, image, video, or audio posts to a user's connected Synapsis account through the official `synapsis` CLI. Use when the user asks to post, publish, or share something on Synapsis; attach local media to a Synapsis post; check Synapsis CLI authentication; or connect a Synapsis node for agent posting.
---

# Post to Synapsis

Use the `synapsis` executable as the only publishing interface. Do not read its credential file, request the user's password, reproduce signing logic, or call Synapsis posting APIs with `curl`.

## Establish intent

- Publish only when the user explicitly asks to post, publish, or share. If the user asks to draft or compose, return a draft without invoking the CLI.
- Treat publishing as an external side effect. Show the exact proposed content first when the request leaves the wording or media selection materially ambiguous.
- Use only media paths supplied or approved by the user. Attach no more than four files.
- Add accurate alt text when the user provides it or it can be stated objectively. Do not invent details that are not evident from the media or user context.

## Check access

Run:

```bash
synapsis auth status --json
```

If the executable is missing, tell the user to install it with:

```bash
npm install --global @gnosyslabs/synapsis-cli
```

Do not install software unless the user authorizes installation.

If no profile is connected, run `synapsis auth connect <node-url>` only after the user identifies their home node. Give the browser approval URL to the user and wait for approval. Never ask for account credentials.

## Select the posting account

Treat profiles as internal credentials, not names the user must know. Resolve the destination from the `profiles` returned by `synapsis auth status --json`:

- If exactly one unexpired profile exists, use it unless the user asks for another account.
- If the user names a username such as `alice` or `@alice`, match it case-insensitively against `profiles[].handle`. If exactly one profile matches, use it.
- If that username matches profiles on multiple nodes, ask which node to use.
- If the user names a node, match its hostname against `profiles[].nodeUrl`. If multiple usernames remain on that node, ask which username to use.
- If multiple posting destinations exist and the user supplies neither a username nor a node, ask which account to use. Present choices as `@username on node-hostname`; include the internal profile name only if it helps distinguish otherwise identical choices.
- If nothing matches, show the available choices and ask instead of guessing.
- If the selected profile is expired, explain that it must be reconnected before posting.

After resolving an account, pass its exact `profiles[].name` through `--profile` on every post, even when it is the current profile. Do not run `synapsis auth use` merely to publish one post.

## Publish

Prefer stdin for agent-authored text so punctuation is passed literally. When using a shell, choose a quoted heredoc delimiter that does not occur in the content:

```bash
synapsis post create --profile alice@social.example --stdin --json <<'SYNAPSIS_POST_EOF'
Exact post content
SYNAPSIS_POST_EOF
```

Attach media by repeating `--media`; place `--alt` immediately after the file it describes:

```bash
synapsis post create --stdin --json \
  --profile alice@social.example \
  --media /absolute/path/photo.jpg --alt "Concise description" \
  --media /absolute/path/audio.flac <<'SYNAPSIS_POST_EOF'
Exact post content
SYNAPSIS_POST_EOF
```

Add `--nsfw` only when the user requests that classification or the intended post is explicitly adult content.

## Handle results safely

- On success, report the returned post URL.
- Do not blindly retry a post after an unknown network outcome; it may have published even if the response was lost. Check with the user before retrying.
- If the CLI reports `STORAGE_NOT_CONFIGURED`, direct the user to Synapsis Settings → Media Storage to connect Stuffbox.
- If authorization is expired or revoked, reconnect through `synapsis auth connect`; never fall back to passwords or browser cookies.
- Keep JSON results concise and never expose local credential contents in logs or responses.
