# End-to-end encrypted direct messages (v1)

This document defines the security and product contract for Synapsis E2EE DMs v1. It is not a security audit or a claim that the feature is suitable for high-risk use.

## Scope

V1 encrypts the UTF-8 text body of new one-to-one direct messages. Existing messages are not protected retroactively. Group chats, images, video, audio, files, reactions, edits, calls, and server-generated link previews are not covered.

Routing metadata remains visible to the participating home nodes: sender and recipient identities and node domains, message and conversation identifiers, key versions, timestamps, delivery/read state, typing state, ciphertext size, request logs, and the social graph.

## Key and message flow

Each account has one static X25519 key pair in v1. The browser generates it during encrypted-message setup. Its public key, identifier, monotonic version, and replacement link are signed by the account's existing DID signing key.

For every message, the sender's browser:

1. Resolves and verifies the recipient's signed X25519 public-key record.
2. Generates a fresh random content key and XChaCha20-Poly1305 nonce.
3. Encrypts the text locally with authenticated sender, recipient, conversation, message, timestamp, protocol, and key-version context.
4. Seals the content key and a transcript hash independently to the sender and recipient X25519 keys. The sender copy makes sent history available on the sender's enrolled devices.
5. Computes a keyed commitment over the authenticated context, nonce, and ciphertext.
6. Signs the complete encrypted envelope with the existing DID signing key.

Nodes authorize, route, federate, and store the signed ciphertext envelope. They receive no plaintext body or content key. Server-side previews are generic. The recipient verifies the signature, bindings, commitment, and AEAD authentication before displaying locally decrypted text.

Delivery wrappers are node-signed and bind the source node, destination node, route, delivery identifier, and expiry. Durable message receipts make retries idempotent and prevent a deleted conversation from being recreated by replaying an old valid envelope.

Federation requests use bounded, redirect-free HTTPS with public-address DNS validation and per-request DNS pinning. Exact loopback HTTP is allowed only in development. Remote key-cache updates use compare-and-swap continuity checks so concurrent lookups cannot roll a cached key backward.

## PIN and device experience

The encrypted-message PIN is separate from login:

- Setup happens only when Chat is first opened, not during login and not for every message.
- The PIN is 6–12 digits and is processed in the browser. The raw PIN is not sent to the node.
- A recognized browser stores the account key under a non-extractable IndexedDB wrapping key, so ordinary visits do not prompt again. Logout clears active application memory while retaining this protected recognized-device record.
- A new or cleared browser completes normal login, then enters the encrypted-message PIN once to recover the same account key.
- Failed recovery attempts are stored durably. Ten failures lock recovery for one hour.
- A forgotten-PIN reset requires the current account password and creates a new encryption key. In v1, old encrypted history no longer opens after that reset; there is no historical-key recovery UI.

There is no administrator plaintext-recovery path. Reset does not decrypt or re-encrypt old messages.

## Recovery service

The private account key is encrypted by a key derived from both Argon2id PIN material and a random server contribution. The database stores the encrypted vault, an HMAC-protected PIN verifier, an encrypted server contribution, and the attempt state.

Every node must set `E2EE_RECOVERY_SECRET` to an independent, high-entropy secret. It must not reuse `AUTH_SECRET`, use a `NEXT_PUBLIC_` name, enter source control, appear in logs, or be included in ordinary exports. Recovery fails closed when it is absent or too short.

This secret is stable node state. Losing or changing it without a deliberate migration makes existing PIN recovery records unusable. A complete node backup needs the database and this secret stored separately in an operational secret manager.

The v1 counter is ordinary application/database enforcement. It is not a hardware-enforced, HSM-backed, threshold, or multi-operator guess limit. Anyone who compromises the running node and its secrets can test the small PIN space offline.

## Threat model

With uncompromised endpoints and the reviewed client build, v1 is intended to keep supported message bodies confidential from:

- a database or backup reader who does not also have the recovery secret;
- network intermediaries, in addition to the protection provided by TLS; and
- honest participating nodes that run the published code and do not capture endpoint secrets.

V1 does not protect message bodies from:

- a malicious home node that serves modified JavaScript capable of reading PINs, keys, or plaintext;
- XSS, a malicious browser extension, endpoint malware, or a compromised operating system;
- a recipient who copies, reports, photographs, or otherwise discloses plaintext; or
- compromise of the static account X25519 private key.

Nodes can still drop, delay, replay, reorder, or refuse ciphertext. Replay records protect local message state, not availability. Message timing, frequency, participant metadata, and approximate size remain observable.

When a node enables Cloudflare Turnstile, its third-party login script shares the credential and account-signing-key trust boundary. A hard navigation removes that realm before Chat creates or restores the E2EE account key, but it does not make a compromised login dependency harmless. Removing or isolating third-party login JavaScript is required before making a stronger endpoint-security claim.

## Legacy history and fail-closed behavior

Existing plaintext DMs remain legacy messages and are visibly marked as sent before encryption. Their original delivery cannot be made E2EE after the fact.

New sends have no plaintext fallback. Sending remains disabled when the recipient has no signed encryption key, key resolution fails, a key version changes, the crypto runtime fails, or the protocol is unsupported. The draft remains in the composer and the user receives an actionable error.

Invalid signatures, altered envelopes, authentication failures, and messages encrypted to an old reset key are displayed as unavailable ciphertext, never as partial or fabricated plaintext.

## Export and migration limits

Account export preserves new message envelopes as ciphertext and preserves legacy messages as legacy plaintext. Fresh v1.1 exports sign a canonical digest of the complete payload. A historical v1.0 account can still migrate without that digest, but all unauthenticated DM history is discarded and the destination warns that the remaining legacy payload must be reviewed for tampering. The server does not decrypt E2EE messages for export.

V1 does not migrate the account encryption private key or recovery enrollment between home nodes. It does migrate the signed public key-continuity anchor. On first opening Chat at the destination, the user sets a PIN once and the browser signs a monotonic replacement key. Preserved old ciphertext remains unreadable on the destination. Copying a node-wide `E2EE_RECOVERY_SECRET` for one account is not acceptable.

Federated DM relationships do not automatically follow a home-node move in v1. The broader federation layer has no signed handle-move proof that updates a peer's cached `user@node` mapping and existing conversation route. A peer that cached the old full handle can therefore reject the migrated handle even though the DID and encryption-key rotation are valid. The import UI warns about this limitation; seamless federated DM migration requires a separate signed move protocol.

Cross-node “delete for everyone” is not offered in v1 because a remote node cannot guarantee deletion. Deleting a federated conversation removes only the local copy.

## Explicit limitations

- No forward secrecy: compromise of the static account private key exposes retained history encrypted to it.
- No post-compromise security: future messages remain exposed until the account key is reset and peers use the replacement.
- One account key is shared across devices; there are no per-device sessions or independent device revocation.
- No key transparency or out-of-band safety-number verification.
- PIN recovery is not X's Juicebox design and is not equivalent to an HSM-backed threshold service.
- This is not Signal Protocol and has no Double Ratchet.
- This is not X Chat's protocol or implementation; only the low-friction PIN experience is a product inspiration.
- Coverage is text-only.
- A malicious home node or maliciously served web client can steal keys and plaintext.

## Review gate

Before broad production enablement or strong security claims, obtain an independent cryptographic and application-security review. It must cover serialization, DID/key binding and rotation, X25519 validation, XChaCha20-Poly1305 and sealed-key usage, nonce generation, authenticated context, replay behavior, local persistence, recovery derivation and limits, federation checks, migrations, XSS/CSP, dependencies, logs, and failure paths.

Publish interoperable protocol test vectors and resolve high-severity findings before presenting v1 as appropriate for sensitive communication. Until then, label it experimental.
