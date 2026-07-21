import Link from 'next/link';
import { StuffboxBadge } from '@/components/StuffboxBadge';

const previewExpiry = '2999-01-01T00:00:00.000Z';

export default function StuffboxBadgesPage() {
    return (
        <main className="stuffbox-explainer">
            <div className="stuffbox-explainer-eyebrow">Portable media, visibly yours</div>
            <h1>Stuffbox badges</h1>
            <p className="stuffbox-explainer-lede">
                Connect your own Stuffbox to keep uploaded media attached to your account—not trapped on one Synapsis node—and earn a badge wherever your profile appears.
            </p>

            <section className="stuffbox-explainer-grid" aria-label="Stuffbox badge levels">
                <article className="stuffbox-explainer-card">
                    <StuffboxBadge
                        badge={{
                            level: 'connected',
                            plan: 'free',
                            issuer: 'https://stuffbox.xyz',
                            attestation: 'preview',
                            expiresAt: previewExpiry,
                        }}
                    />
                    <h2>Connected</h2>
                    <p>Confirms that this exact <code>@handle@node</code> currently has official Stuffbox storage connected.</p>
                    <ul>
                        <li>Portable, user-owned media storage</li>
                        <li>Media remains available when moving between nodes</li>
                        <li>A trusted badge across the federation</li>
                    </ul>
                </article>

                <article className="stuffbox-explainer-card stuffbox-explainer-card-supporter">
                    <StuffboxBadge
                        badge={{
                            level: 'supporter',
                            plan: 'plus',
                            issuer: 'https://stuffbox.xyz',
                            attestation: 'preview',
                            expiresAt: previewExpiry,
                        }}
                    />
                    <h2>Paid plan</h2>
                    <p>Confirms that Stuffbox reports an active paid plan for this account. The checkmark gets an animated finish.</p>
                    <ul>
                        <li>Everything in Connected</li>
                        <li>More storage according to your Stuffbox plan</li>
                        <li>Animated paid-plan checkmark</li>
                    </ul>
                </article>
            </section>

            <aside className="stuffbox-explainer-note">
                These badges verify a current Stuffbox connection or subscription for an account. They do not verify someone’s legal identity, claims, or posts.
            </aside>

            <div className="stuffbox-explainer-actions">
                <Link className="btn btn-primary" href="/settings/storage">Connect Stuffbox</Link>
                <a className="btn btn-ghost" href="https://stuffbox.xyz/pricing" target="_blank" rel="noopener noreferrer">See Stuffbox plans</a>
            </div>
        </main>
    );
}
