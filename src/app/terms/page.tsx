import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
    title: 'Terms of Service | Synapsis',
    description: 'The terms that govern use of the Synapsis node operated by Gnosys Labs.',
};

const sections = [
    { id: 'agreement', label: 'Agreement and eligibility' },
    { id: 'accounts', label: 'Accounts and security' },
    { id: 'content', label: 'Your content' },
    { id: 'federation', label: 'Federation and public activity' },
    { id: 'media', label: 'Media and third-party services' },
    { id: 'agents', label: 'CLI and agent access' },
    { id: 'messages', label: 'Messages and encryption' },
    { id: 'conduct', label: 'Acceptable use' },
    { id: 'moderation', label: 'Moderation and enforcement' },
    { id: 'intellectual-property', label: 'Intellectual property' },
    { id: 'service', label: 'Service changes and termination' },
    { id: 'disclaimers', label: 'Disclaimers' },
    { id: 'liability', label: 'Limitation of liability' },
    { id: 'general', label: 'General terms' },
    { id: 'changes', label: 'Changes and contact' },
];

export default function TermsOfServicePage() {
    return (
        <LegalPage
            eyebrow="Gnosys Labs"
            title="Terms of Service"
            summary="These Terms govern your use of the Synapsis node operated by Gnosys Labs. Synapsis is a public, federated network: your actions can reach independently operated nodes, and you are responsible for what you publish and what you authorize."
            sections={sections}
        >
            <section id="agreement" className="legal-section">
                <h2>1. Agreement and eligibility</h2>
                <p>
                    These Terms of Service (“Terms”) are an agreement between you and Gnosys Labs (“we,” “us,” or
                    “our”) governing your use of the Synapsis website and services at{' '}
                    <a href="https://synapsis.gnosyslabs.xyz">synapsis.gnosyslabs.xyz</a>, including its web application,
                    APIs, and command-line access (the “Service”). By creating an account or using the Service, you agree
                    to these Terms and our <a href="/privacy">Privacy Policy</a>.
                </p>
                <p>
                    You must be at least 13 years old and legally able to agree to these Terms. If the law where you live
                    requires a higher minimum age, that higher age applies. You must be at least 18 and legally permitted
                    to access any node or feature classified for adult content. If you use the Service for an organization,
                    you represent that you have authority to bind it to these Terms.
                </p>
            </section>

            <section id="accounts" className="legal-section">
                <h2>2. Accounts and security</h2>
                <p>
                    Provide accurate registration information, keep it current, and do not impersonate another person or
                    misrepresent your affiliation. You are responsible for activity under your account and for protecting
                    your password, account-signing material, message-recovery secret, active sessions, CLI credentials,
                    and connected services. Tell us promptly at{' '}
                    <a href="mailto:admin@gnosyslabs.xyz">admin@gnosyslabs.xyz</a> if you believe your account has been
                    compromised.
                </p>
                <p>
                    Handles and decentralized identifiers are used across a federated network. We may reclaim or change a
                    handle when reasonably necessary to resolve impersonation, infringement, security, or technical issues.
                </p>
            </section>

            <section id="content" className="legal-section">
                <h2>3. Your content</h2>
                <p>
                    You retain your ownership rights in content you submit. You grant Gnosys Labs a worldwide,
                    non-exclusive, royalty-free license to host, store, reproduce, process, adapt for technical formatting,
                    display, transmit, and distribute that content only as needed to operate, secure, improve, and
                    federate the Service. This license includes delivering public content and authorized messages to other
                    users and nodes. It ends when the content is deleted from our active systems, except where continued
                    handling is needed for backups, legal obligations, security, or copies outside our control.
                </p>
                <p>
                    You represent that you have the rights and permissions needed to submit your content and that our use
                    of it as described in these Terms will not violate another person’s rights or the law. You are solely
                    responsible for your content and the consequences of sharing it.
                </p>
            </section>

            <section id="federation" className="legal-section">
                <h2>4. Federation and public activity</h2>
                <div className="legal-callout">
                    <strong>Public posts can leave this node.</strong>
                    <p>Other nodes, search engines, archives, and users may keep copies that Gnosys Labs cannot control or delete.</p>
                </div>
                <p>
                    Synapsis exchanges profiles, posts, media references, and interactions with independently operated
                    nodes. Their rules, availability, moderation, security, and privacy practices may differ from ours.
                    We do not control and are not responsible for other nodes. Federation delivery is not guaranteed, and
                    we may block or limit a node when needed for safety, abuse prevention, reliability, or legal compliance.
                </p>
            </section>

            <section id="media" className="legal-section">
                <h2>5. Media and third-party services</h2>
                <p>
                    Posting media requires a connected Stuffbox service. Stuffbox and any other third-party service or
                    website you connect to Synapsis is governed by its own terms and policies. You authorize Synapsis to
                    use approved credentials and scopes to interact with that service on your behalf. You are responsible
                    for the media you store there and for managing or deleting it with the provider.
                </p>
                <p>
                    We are not responsible for third-party services, content, availability, security, or data practices.
                    Links and previews do not imply endorsement.
                </p>
            </section>

            <section id="agents" className="legal-section">
                <h2>6. CLI and agent access</h2>
                <p>
                    You may authorize the Synapsis CLI, automated tools, or AI agents to act on your account within
                    approved scopes. Actions performed with a valid delegated credential are treated as actions you
                    authorized. You are responsible for reviewing proposed content, selecting the correct account and node,
                    limiting credential access, and revoking credentials that are lost, shared, or no longer needed.
                </p>
                <p>
                    Do not use automation to spam, manipulate engagement, evade limits, scrape unlawfully, or otherwise
                    violate these Terms. We may rate-limit, suspend, or revoke automated access that threatens users or the
                    Service.
                </p>
            </section>

            <section id="messages" className="legal-section">
                <h2>7. Messages and encryption</h2>
                <p>
                    Encryption currently protects the text body of supported new one-to-one direct messages. It does not
                    protect legacy messages, group chats, media, files, reactions, edits, calls, link previews, or message
                    routing metadata. Encryption is not a guarantee of recipient behavior, endpoint security, anonymity,
                    availability, forward secrecy, or recovery of old history after a key reset.
                </p>
                <p>
                    Treat encrypted messaging as experimental and do not rely on it for emergencies or situations where a
                    failure could cause serious harm. Deleting a federated conversation deletes the local copy only; a
                    remote node or recipient may retain its copy.
                </p>
            </section>

            <section id="conduct" className="legal-section">
                <h2>8. Acceptable use</h2>
                <p>You may not use the Service to:</p>
                <ul>
                    <li>break the law or encourage, facilitate, or coordinate illegal activity;</li>
                    <li>exploit or endanger children, or create, possess, request, or distribute child sexual abuse material;</li>
                    <li>threaten violence, stalk, harass, dox, defraud, impersonate, or unlawfully discriminate against others;</li>
                    <li>share intimate material without consent or violate another person’s privacy, publicity, intellectual-property, or other rights;</li>
                    <li>distribute malware, phishing, credential theft, destructive code, or content intended to compromise systems or accounts;</li>
                    <li>spam, artificially manipulate engagement, evade enforcement, or operate deceptive coordinated accounts;</li>
                    <li>probe, attack, overload, disrupt, or circumvent the security or access controls of the Service or another node; or</li>
                    <li>access or collect data by automated means except through authorized interfaces and in compliance with law, these Terms, and reasonable rate limits.</li>
                </ul>
                <p>You must also follow the node rules displayed in the Service. Those rules are incorporated into these Terms.</p>
            </section>

            <section id="moderation" className="legal-section">
                <h2>9. Moderation and enforcement</h2>
                <p>
                    We may investigate, label, limit, remove, or preserve content; restrict federation; revoke credentials;
                    or suspend or terminate accounts when we reasonably believe it is needed to enforce these Terms or node
                    rules, protect the Service or others, respond to legal obligations, or address security and operational
                    risk. Moderation is imperfect, and we do not promise to review all content or disputes.
                </p>
                <p>
                    To report content or request review of an enforcement decision, use the in-product reporting tools or
                    email <a href="mailto:admin@gnosyslabs.xyz">admin@gnosyslabs.xyz</a> with enough information for us to
                    identify the account, content, and issue.
                </p>
            </section>

            <section id="intellectual-property" className="legal-section">
                <h2>10. Intellectual property</h2>
                <p>
                    The Service’s software, branding, design, and other materials are owned by Gnosys Labs or its licensors
                    and are protected by applicable law. Open-source components are governed by their respective licenses.
                    These Terms do not grant you rights to use Gnosys Labs or Synapsis names, logos, or trademarks except as
                    needed to identify the Service truthfully.
                </p>
                <p>
                    If you believe content on this node infringes your rights, email{' '}
                    <a href="mailto:admin@gnosyslabs.xyz">admin@gnosyslabs.xyz</a> with your contact information, a
                    description and location of the material, the basis for your claim, and any legally required statements.
                </p>
            </section>

            <section id="service" className="legal-section">
                <h2>11. Service changes and termination</h2>
                <p>
                    We may add, change, suspend, limit, or discontinue features or the Service. We do not guarantee that the
                    Service or any content will always be available, preserved, compatible, or delivered to another node.
                    You may stop using the Service at any time and may export or delete your account through Settings.
                </p>
                <p>
                    If these Terms end, provisions that by their nature should survive will remain in effect, including
                    provisions concerning ownership, public or federated copies, disclaimers, limitations of liability, and
                    dispute-related terms.
                </p>
            </section>

            <section id="disclaimers" className="legal-section">
                <h2>12. Disclaimers</h2>
                <p className="legal-uppercase">
                    To the maximum extent permitted by law, the Service is provided “as is” and “as available.” Gnosys Labs
                    disclaims all warranties, express or implied, including warranties of merchantability, fitness for a
                    particular purpose, title, non-infringement, security, availability, and accuracy. We do not warrant
                    that the Service will be uninterrupted, error-free, secure, or free of harmful components, or that
                    content or messages will be preserved or delivered.
                </p>
                <p>Nothing in these Terms excludes warranties or rights that cannot lawfully be excluded.</p>
            </section>

            <section id="liability" className="legal-section">
                <h2>13. Limitation of liability</h2>
                <p className="legal-uppercase">
                    To the maximum extent permitted by law, Gnosys Labs and its contributors, providers, and representatives
                    will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or
                    for loss of profits, data, goodwill, use, or other intangible losses, arising from or related to the
                    Service, third-party services, other users, or these Terms.
                </p>
                <p>
                    To the maximum extent permitted by law, our total liability for all claims arising from or related to
                    the Service or these Terms will not exceed the greater of US $100 or the amount you paid us, if any, for
                    the Service during the 12 months before the event giving rise to the claim. These limits do not apply
                    where prohibited by law.
                </p>
            </section>

            <section id="general" className="legal-section">
                <h2>14. General terms</h2>
                <p>
                    You are responsible for complying with laws that apply to you and your content. Mandatory consumer
                    protections that apply where you live are not limited by these Terms. If a provision is unenforceable,
                    it will be enforced to the maximum permissible extent and the remaining provisions will remain in
                    effect. Our failure to enforce a provision is not a waiver. You may not transfer these Terms without
                    our consent; we may transfer them in connection with a reorganization or transfer of the Service.
                </p>
                <p>
                    These Terms, the Privacy Policy, and the displayed node rules are the entire agreement between you and
                    Gnosys Labs regarding the Service, unless we expressly agree otherwise in writing.
                </p>
            </section>

            <section id="changes" className="legal-section">
                <h2>15. Changes and contact</h2>
                <p>
                    We may update these Terms to reflect changes to the Service, risk, or law. We will post revised Terms
                    here and update the date above; when appropriate, we may provide additional notice. By continuing to use
                    the Service after revised Terms take effect, you agree to them. If you do not agree, stop using the
                    Service and delete your account.
                </p>
                <p>
                    Questions about these Terms can be sent to Gnosys Labs at{' '}
                    <a href="mailto:admin@gnosyslabs.xyz">admin@gnosyslabs.xyz</a>.
                </p>
            </section>
        </LegalPage>
    );
}
