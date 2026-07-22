'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUpRight, Check, Download, LogOut, Smartphone } from 'lucide-react';
import { useAuth } from '@/lib/contexts/AuthContext';
import { getSafeIosPublicUrl } from '@/lib/platform/ios-web-funnel';

export function IosAppHandoff() {
    const router = useRouter();
    const { user, loading, logout } = useAuth();
    const [signingOut, setSigningOut] = useState(false);
    const openAppUrl = getSafeIosPublicUrl(process.env.NEXT_PUBLIC_IOS_APP_URL, true);
    const appStoreUrl = getSafeIosPublicUrl(process.env.NEXT_PUBLIC_IOS_APP_STORE_URL);

    const handleSignOut = async () => {
        if (signingOut) return;
        setSigningOut(true);
        try {
            await logout();
            router.replace('/login?app=ios');
        } finally {
            setSigningOut(false);
        }
    };

    if (loading) {
        return (
            <main className="ios-handoff-page app-handoff-loading" role="status" aria-label="Checking your account">
                <div className="app-handoff-loading-spinner" />
            </main>
        );
    }

    if (!user) {
        return (
            <main className="ios-handoff-page">
                <section className="ios-handoff-card">
                    <Image src="/logotext.svg" alt="Synapsis" width={184} height={44} priority />
                    <div className="ios-handoff-icon"><Smartphone size={28} /></div>
                    <p className="ios-handoff-eyebrow">iPhone account setup</p>
                    <h1>Set up your account first</h1>
                    <p className="ios-handoff-lede">
                        Create your account on this node, then continue in the app. Existing users sign in directly inside Synapsis.
                    </p>
                    <Link className="btn btn-primary ios-handoff-primary" href="/login?app=ios">
                        Create an account
                    </Link>
                    <p className="ios-handoff-text-link">Already have an account? Sign in inside the app.</p>
                </section>
            </main>
        );
    }

    return (
        <main className="ios-handoff-page">
            <section className="ios-handoff-card">
                <Image src="/logotext.svg" alt="Synapsis" width={184} height={44} priority />
                <div className="ios-handoff-icon ios-handoff-icon-ready"><Check size={30} strokeWidth={2.5} /></div>
                <p className="ios-handoff-eyebrow">Account ready</p>
                <h1>Continue in Synapsis</h1>
                <p className="ios-handoff-lede">
                    <strong>{user.handle}</strong> is ready. Return to the Synapsis app and sign in with the email and password you just used.
                </p>

                <div className="ios-handoff-steps" aria-label="Next steps">
                    <div><span>1</span><p>Return to or download the Synapsis app.</p></div>
                    <div><span>2</span><p>Choose this node and sign in to your account.</p></div>
                </div>

                <div className="ios-handoff-actions">
                    {openAppUrl && (
                        <a className="btn btn-primary ios-handoff-primary" href={openAppUrl}>
                            <Smartphone size={18} /> Open Synapsis
                        </a>
                    )}
                    {appStoreUrl && (
                        <a
                            className={`btn ${openAppUrl ? 'btn-secondary' : 'btn-primary'} ios-handoff-primary`}
                            href={appStoreUrl}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <Download size={18} /> Download on the App Store <ArrowUpRight size={15} />
                        </a>
                    )}
                </div>

                {!openAppUrl && !appStoreUrl && (
                    <div className="ios-handoff-return-note">
                        You can close this page now and return to Synapsis on your iPhone.
                    </div>
                )}

                <p className="ios-handoff-boundary">
                    The website stops here on iPhone by design. Synapsis is a native app experience.
                </p>
                <button
                    type="button"
                    className="ios-handoff-signout"
                    onClick={handleSignOut}
                    disabled={signingOut}
                >
                    <LogOut size={14} /> {signingOut ? 'Signing out…' : 'Wrong account? Sign out'}
                </button>
            </section>
        </main>
    );
}
