import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StuffboxBadge } from './StuffboxBadge';

describe('StuffboxBadge', () => {
  it('renders the connected account meaning', () => {
    const html = renderToStaticMarkup(createElement(StuffboxBadge, {
      badge: {
        level: 'connected',
        plan: 'free',
        issuer: 'https://stuffbox.xyz',
        attestation: 'proof',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    }));
    expect(html).toContain('stuffbox-badge-connected');
    expect(html).toContain('stuffbox-badge-seal');
    expect(html).toContain('stuffbox-badge-check');
    expect(html).not.toContain('stuffbox-badge-label');
  });

  it('renders the animated supporter style and hides expired proofs', () => {
    const supporter = renderToStaticMarkup(createElement(StuffboxBadge, {
      badge: {
        level: 'supporter',
        plan: 'plus',
        issuer: 'https://stuffbox.xyz',
        attestation: 'proof',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    }));
    expect(supporter).toContain('stuffbox-badge-supporter');
    expect(supporter).toContain('stuffbox-badge-seal');
    expect(supporter).toContain('stuffbox-badge-check');
    expect((supporter.match(/class="stuffbox-badge-spark /g) ?? [])).toHaveLength(3);
    expect(supporter).not.toContain('stuffbox-badge-label');
    expect(renderToStaticMarkup(createElement(StuffboxBadge, {
      badge: {
        level: 'connected',
        plan: 'free',
        issuer: 'https://stuffbox.xyz',
        attestation: 'proof',
        expiresAt: '2000-01-01T00:00:00.000Z',
      },
    }))).toBe('');
  });
});
