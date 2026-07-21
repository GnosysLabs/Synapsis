import Link from 'next/link';
import type { StuffboxBadge as StuffboxBadgeValue } from '@/lib/types';

interface StuffboxBadgeProps {
    badge?: StuffboxBadgeValue | null;
    linked?: boolean;
    className?: string;
}

function isCurrentBadge(badge?: StuffboxBadgeValue | null): badge is StuffboxBadgeValue {
    return Boolean(badge && Number.isFinite(Date.parse(badge.expiresAt)) && Date.parse(badge.expiresAt) > Date.now());
}

export function StuffboxBadge({
    badge,
    linked = false,
    className = '',
}: StuffboxBadgeProps) {
    if (!isCurrentBadge(badge)) return null;

    const supporter = badge.level === 'supporter';
    const description = supporter
        ? `Paid Stuffbox plan (${badge.plan})`
        : 'Stuffbox connected';
    const mark = (
        <span
            className={`stuffbox-badge stuffbox-badge-${badge.level} ${className}`.trim()}
            aria-label={description}
            title={description}
        >
            <span className="stuffbox-badge-icon" aria-hidden="true">
                {supporter ? (
                    <svg viewBox="0 0 20 20" role="presentation">
                        <circle cx="10" cy="10" r="8.5" />
                        <path className="stuffbox-badge-check" d="m6.2 10.1 2.35 2.35 5.25-5.25" />
                        <path className="stuffbox-badge-spark" d="m15.9 2 .45 1.15L17.5 3.6l-1.15.45-.45 1.15-.45-1.15-1.15-.45 1.15-.45L15.9 2Z" />
                    </svg>
                ) : (
                    <svg viewBox="0 0 20 20" role="presentation">
                        <circle cx="10" cy="10" r="8.5" />
                        <path className="stuffbox-badge-check" d="m6.2 10.1 2.35 2.35 5.25-5.25" />
                    </svg>
                )}
            </span>
        </span>
    );

    return linked ? (
        <Link
            href="/stuffbox"
            className="stuffbox-badge-link"
            aria-label={`${description} Learn about Stuffbox badges.`}
        >
            {mark}
        </Link>
    ) : mark;
}
