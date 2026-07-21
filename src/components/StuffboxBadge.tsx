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
                <svg viewBox="0 0 24 24" role="presentation">
                    <path
                        className="stuffbox-badge-seal"
                        d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
                    />
                    <path className="stuffbox-badge-check" d="m8.5 12.2 2.25 2.25 4.9-4.9" />
                    {supporter && (
                        <path className="stuffbox-badge-spark" d="m20 1.2.48 1.22 1.22.48-1.22.48L20 4.6l-.48-1.22-1.22-.48 1.22-.48L20 1.2Z" />
                    )}
                </svg>
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
