import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFile(resolve(process.cwd(), path), 'utf8');

describe('public legal pages', () => {
    it('publishes privacy and terms as standalone public routes', async () => {
        const [layout, privacy, terms] = await Promise.all([
            source('src/components/LayoutWrapper.tsx'),
            source('src/app/privacy/page.tsx'),
            source('src/app/terms/page.tsx'),
        ]);

        expect(layout).toContain("pathname === '/privacy'");
        expect(layout).toContain("pathname === '/terms'");
        expect(privacy).toContain("title: 'Privacy Policy | Synapsis'");
        expect(terms).toContain("title: 'Terms of Service | Synapsis'");
    });

    it('identifies the operator, contact address, and effective date', async () => {
        const [legalPage, privacy, terms] = await Promise.all([
            source('src/components/LegalPage.tsx'),
            source('src/app/privacy/page.tsx'),
            source('src/app/terms/page.tsx'),
        ]);

        expect(legalPage).toContain('Effective July 17, 2026');
        for (const page of [privacy, terms]) {
            expect(page).toContain('Gnosys Labs');
            expect(page).toContain('admin@gnosyslabs.xyz');
        }
    });

    it('makes both policies discoverable from shared site surfaces', async () => {
        const [links, rightSidebar, authScreen] = await Promise.all([
            source('src/components/LegalLinks.tsx'),
            source('src/components/RightSidebar.tsx'),
            source('src/components/AuthScreen.tsx'),
        ]);

        expect(links).toContain('href="/privacy"');
        expect(links).toContain('href="/terms"');
        expect(rightSidebar).toContain('<LegalLinks');
        expect(authScreen).toContain('<LegalLinks');
    });

    it('discloses federation, media storage, messaging, and delegated agent access', async () => {
        const [privacy, terms] = await Promise.all([
            source('src/app/privacy/page.tsx'),
            source('src/app/terms/page.tsx'),
        ]);

        for (const disclosure of ['federat', 'Stuffbox', 'CLI', 'agent', 'message']) {
            expect(privacy.toLowerCase()).toContain(disclosure.toLowerCase());
            expect(terms.toLowerCase()).toContain(disclosure.toLowerCase());
        }
    });
});
