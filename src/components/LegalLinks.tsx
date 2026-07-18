import Link from 'next/link';

interface LegalLinksProps {
    className?: string;
    includeContact?: boolean;
}

export function LegalLinks({ className = '', includeContact = false }: LegalLinksProps) {
    return (
        <nav className={`legal-links ${className}`.trim()} aria-label="Legal">
            <Link href="/privacy">Privacy</Link>
            <span aria-hidden="true">·</span>
            <Link href="/terms">Terms</Link>
            {includeContact && (
                <>
                    <span aria-hidden="true">·</span>
                    <a href="mailto:admin@gnosyslabs.xyz">Contact</a>
                </>
            )}
        </nav>
    );
}
