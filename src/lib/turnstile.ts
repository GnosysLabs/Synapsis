import { db, nodes } from '@/db';
import { eq } from 'drizzle-orm';

export async function verifyTurnstileToken(token: string, ip?: string): Promise<boolean> {
    try {
        // Get node settings to check if Turnstile is enabled
        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const node = await db.query.nodes.findFirst({
            where: { domain: domain },
        });

        // If no secret key is configured, skip verification (Turnstile is disabled)
        if (!node?.turnstileSecretKey) {
            return true;
        }

        // Verify the token with Cloudflare
        const formData = new FormData();
        formData.append('secret', node.turnstileSecretKey);
        formData.append('response', token);
        if (ip) {
            formData.append('remoteip', ip);
        }

        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData,
        });

        const data = await response.json();
        return data.success === true;
    } catch (error) {
        console.error('Turnstile verification error:', error);
        // On error, fail closed (reject the request)
        return false;
    }
}

export async function getTurnstileSiteKey(): Promise<string | null> {
    try {
        const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
        const node = await db.query.nodes.findFirst({
            where: { domain: domain },
        });

        return node?.turnstileSiteKey || null;
    } catch (error) {
        console.error('Error fetching Turnstile site key:', error);
        return null;
    }
}
