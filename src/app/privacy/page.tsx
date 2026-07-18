import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
    title: 'Privacy Policy | Synapsis',
    description: 'How Gnosys Labs collects, uses, shares, and protects information when you use Synapsis.',
};

const sections = [
    { id: 'scope', label: 'Scope and operator' },
    { id: 'information', label: 'Information we handle' },
    { id: 'use', label: 'How we use information' },
    { id: 'public-federation', label: 'Public content and federation' },
    { id: 'messages', label: 'Direct messages' },
    { id: 'media', label: 'Media and Stuffbox' },
    { id: 'sharing', label: 'How information is shared' },
    { id: 'retention', label: 'Retention and deletion' },
    { id: 'choices', label: 'Your choices and rights' },
    { id: 'security', label: 'Security' },
    { id: 'children', label: 'Children' },
    { id: 'international', label: 'International use' },
    { id: 'changes', label: 'Changes and contact' },
];

export default function PrivacyPolicyPage() {
    return (
        <LegalPage
            eyebrow="Gnosys Labs"
            title="Privacy Policy"
            summary="This policy explains what information the Synapsis node operated by Gnosys Labs handles, why it is handled, and the choices available to you. Synapsis is a federated social network, so public activity may travel beyond this node."
            sections={sections}
        >
            <section id="scope" className="legal-section">
                <h2>1. Scope and operator</h2>
                <p>
                    This Privacy Policy applies to the Synapsis website and services available at{' '}
                    <a href="https://synapsis.gnosyslabs.xyz">synapsis.gnosyslabs.xyz</a>, including its web application,
                    APIs, and command-line access (the “Service”). The Service is operated by Gnosys Labs (“we,”
                    “us,” or “our”). Other Synapsis nodes and connected services are operated independently and have
                    their own privacy practices.
                </p>
            </section>

            <section id="information" className="legal-section">
                <h2>2. Information we handle</h2>
                <p>We handle the following categories of information when you use the Service:</p>
                <ul>
                    <li><strong>Account information:</strong> your email address, handle, display name, password hash, account settings, age-confirmation status where required, and account creation and update times.</li>
                    <li><strong>Profile and social information:</strong> your bio, website, profile images, decentralized identifier (DID), public keys, follows, blocks, mutes, and other social-graph information.</li>
                    <li><strong>Content and activity:</strong> posts, replies, reposts, likes, media metadata, alt text, reports, moderation records, notifications, and related timestamps.</li>
                    <li><strong>Authentication and security information:</strong> session records, encrypted account-signing material, signed-action records, and encrypted recovery-vault information used for supported encrypted messages.</li>
                    <li><strong>CLI and agent access:</strong> device names, public keys, fingerprints, approved scopes, expiration, revocation, and last-used times for delegated command-line credentials. The CLI’s private key remains on the device where it was created.</li>
                    <li><strong>Technical information:</strong> our servers and infrastructure may process IP addresses, request details, browser or device information, error data, and security and diagnostic logs when you connect to the Service.</li>
                    <li><strong>Communications:</strong> information you send when you contact us for support, privacy requests, or other questions.</li>
                </ul>
                <p>
                    You may browse public content without an account. Some technical information is still processed to
                    deliver the site, protect it from abuse, and diagnose failures.
                </p>
            </section>

            <section id="use" className="legal-section">
                <h2>3. How we use information</h2>
                <p>We use information to:</p>
                <ul>
                    <li>create and secure accounts, maintain sessions, and authenticate signed actions;</li>
                    <li>publish, deliver, federate, and display posts, profiles, media references, and social interactions;</li>
                    <li>route messages and notifications and support account export, import, and migration features;</li>
                    <li>provide moderation, content controls, blocking, muting, reporting, and abuse prevention;</li>
                    <li>operate delegated CLI and agent access that you approve;</li>
                    <li>maintain, troubleshoot, measure, and improve the Service; and</li>
                    <li>comply with law and protect users, Gnosys Labs, and the public.</li>
                </ul>
                <p>We do not sell or rent personal information for advertising.</p>
            </section>

            <section id="public-federation" className="legal-section">
                <h2>4. Public content and federation</h2>
                <div className="legal-callout">
                    <strong>Synapsis is public and federated.</strong>
                    <p>Assume that anything you post publicly can be seen, copied, indexed, and redistributed by others.</p>
                </div>
                <p>
                    Public profiles, posts, media URLs, and interactions may be sent to, requested by, cached on, or
                    displayed by other Synapsis nodes. Those nodes are controlled by third parties, not Gnosys Labs.
                    Deleting content here does not guarantee that copies already delivered to another node, a search
                    engine, an archive, or another person will be removed.
                </p>
                <p>
                    Synapsis also processes public information received from other nodes so that federated profiles,
                    feeds, replies, and interactions work. Remote-node operators determine their own handling of data.
                </p>
            </section>

            <section id="messages" className="legal-section">
                <h2>5. Direct messages</h2>
                <p>
                    For supported new one-to-one messages, Synapsis encrypts the text body in your browser and stores
                    and routes ciphertext. Participating home nodes still process routing metadata, including sender and
                    recipient identities, node domains, conversation and message identifiers, key versions, timestamps,
                    delivery and read state, typing state, approximate message size, and request logs.
                </p>
                <p>
                    Encryption does not apply retroactively. Legacy messages may remain in plaintext, and group chats,
                    media, files, reactions, edits, calls, and server-generated link previews are not covered by the
                    current text-message encryption. Recipients can always save or share what they receive. Deleting a
                    federated conversation removes the local copy but cannot guarantee deletion from another node.
                </p>
            </section>

            <section id="media" className="legal-section">
                <h2>6. Media and Stuffbox</h2>
                <p>
                    Media uploads require a Stuffbox account that you connect. Media bytes are uploaded to the connected
                    Stuffbox service; Synapsis stores the resulting URLs, asset identifiers, file type, dimensions, alt
                    text, ownership, and post association. We store encrypted Stuffbox access and refresh tokens so the
                    Service can upload media on your behalf within the scopes you approve.
                </p>
                <p>
                    The operator of your Stuffbox service handles the media file under its own terms and privacy policy.
                    Disconnecting Stuffbox or deleting your Synapsis account does not necessarily delete media retained by
                    Stuffbox; manage or delete those files with that provider as well.
                </p>
            </section>

            <section id="sharing" className="legal-section">
                <h2>7. How information is shared</h2>
                <p>We may disclose information:</p>
                <ul>
                    <li><strong>At your direction:</strong> when you publish, federate, connect Stuffbox, authorize a CLI device or agent, or otherwise ask us to perform an action.</li>
                    <li><strong>With other users and nodes:</strong> as needed to provide public and federated social features and message delivery.</li>
                    <li><strong>With infrastructure providers:</strong> vendors that help host, secure, monitor, or deliver the Service. If Cloudflare Turnstile is configured, Cloudflare processes information needed to provide its anti-abuse challenge.</li>
                    <li><strong>For safety and legal reasons:</strong> when reasonably necessary to comply with law, respond to valid legal process, enforce our Terms, investigate abuse, or protect rights, safety, and the Service.</li>
                    <li><strong>During an organizational change:</strong> in connection with a merger, financing, acquisition, reorganization, or transfer of the Service, subject to applicable law.</li>
                </ul>
            </section>

            <section id="retention" className="legal-section">
                <h2>8. Retention and deletion</h2>
                <p>
                    We retain account information and content while your account is active and as needed to operate,
                    secure, and maintain the Service. Some security, moderation, transaction, diagnostic, and backup
                    records may be retained longer where reasonably necessary or required by law.
                </p>
                <p>
                    You can delete your account from <strong>Settings → Security</strong>. Account deletion removes the
                    account and associated data from the local active database, subject to limited backup, security,
                    legal, and fraud-prevention retention. It cannot recall public or federated copies already shared with
                    others, and it may not delete media held by your Stuffbox provider.
                </p>
            </section>

            <section id="choices" className="legal-section">
                <h2>9. Your choices and rights</h2>
                <p>You can use the Service’s settings to update profile information, change content and messaging preferences, revoke CLI credentials, disconnect Stuffbox, export your account, and delete your account.</p>
                <p>
                    Depending on where you live, you may also have rights to request access, correction, deletion, or a
                    portable copy of personal information, or to object to or restrict certain processing. To submit a
                    request, email <a href="mailto:admin@gnosyslabs.xyz">admin@gnosyslabs.xyz</a>. We may need to verify
                    your identity before completing it. We will not discriminate against you for exercising applicable
                    privacy rights.
                </p>
            </section>

            <section id="security" className="legal-section">
                <h2>10. Security</h2>
                <p>
                    We use technical and organizational safeguards designed to protect information, including hashed
                    passwords, encrypted stored secrets, signed actions, revocable delegated credentials, and encryption
                    for supported message text. No online service is perfectly secure, and we cannot guarantee that
                    unauthorized access, loss, or misuse will never occur. Protect your password, message-recovery secret,
                    CLI devices, and connected accounts, and notify us if you suspect compromise.
                </p>
            </section>

            <section id="children" className="legal-section">
                <h2>11. Children</h2>
                <p>
                    The Service is not directed to children under 13, and they may not create an account. If you believe a
                    child under 13 has provided personal information, contact us so we can investigate and take appropriate
                    action. Nodes or features classified for adult content are limited to users who are at least 18 and
                    legally permitted to view that content.
                </p>
            </section>

            <section id="international" className="legal-section">
                <h2>12. International use</h2>
                <p>
                    Synapsis is available across a distributed network. Information may be processed in countries other
                    than your own, including wherever this node’s providers, a connected Stuffbox service, or federated
                    nodes operate. Their privacy laws may differ from those where you live.
                </p>
            </section>

            <section id="changes" className="legal-section">
                <h2>13. Changes and contact</h2>
                <p>
                    We may update this policy as the Service or legal requirements change. We will post the revised policy
                    here and update the date above; when appropriate, we may provide additional notice in the Service.
                </p>
                <p>
                    Questions or privacy requests can be sent to Gnosys Labs at{' '}
                    <a href="mailto:admin@gnosyslabs.xyz">admin@gnosyslabs.xyz</a>.
                </p>
            </section>
        </LegalPage>
    );
}
