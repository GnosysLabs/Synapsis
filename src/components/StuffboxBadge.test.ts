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
      showLabel: true,
    }));
    expect(html).toContain('Stuffbox Connected');
    expect(html).toContain('stuffbox-badge-connected');
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
