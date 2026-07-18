import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LegalLinks } from './LegalLinks';

interface SectionLink {
    id: string;
    label: string;
}

interface LegalPageProps {
    eyebrow: string;
    title: string;
    summary: string;
    sections: SectionLink[];
    children: ReactNode;
}

export function LegalPage({ eyebrow, title, summary, sections, children }: LegalPageProps) {
    return (
        <div className="legal-shell">
            <header className="legal-site-header">
                <div className="legal-site-header-inner">
                    <Link href="/" className="legal-brand" aria-label="Synapsis home">
                        <Image src="/logotext.svg" alt="Synapsis" width={180} height={41} priority />
                    </Link>
                    <div className="legal-header-actions">
                        <LegalLinks />
                        <Link href="/login" className="legal-sign-in-link">Sign in</Link>
                    </div>
                </div>
            </header>

            <main className="legal-main">
                <aside className="legal-toc" aria-label={`${title} contents`}>
                    <p className="legal-toc-label">On this page</p>
                    <ol>
                        {sections.map((section) => (
                            <li key={section.id}>
                                <a href={`#${section.id}`}>{section.label}</a>
                            </li>
                        ))}
                    </ol>
                </aside>

                <article className="legal-document">
                    <div className="legal-document-header">
                        <p className="legal-eyebrow">{eyebrow}</p>
                        <h1>{title}</h1>
                        <p className="legal-updated">Effective July 17, 2026 · Last updated July 17, 2026</p>
                        <p className="legal-summary">{summary}</p>
                    </div>
                    {children}
                </article>
            </main>

            <footer className="legal-site-footer">
                <div>
                    <strong>Synapsis</strong>
                    <span>A Gnosys Labs project.</span>
                </div>
                <LegalLinks includeContact />
            </footer>
        </div>
    );
}
