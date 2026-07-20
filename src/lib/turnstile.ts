import { db } from '@/db';

export type TurnstileAction = 'login' | 'register';

export interface TurnstileConfiguration {
    siteKey: string;
    secretKey: string;
    hostname: string;
}

interface TurnstileVerificationOptions {
    action: TurnstileAction;
    configuration: TurnstileConfiguration;
    ip?: string;
}

interface TurnstileSiteverifyResponse {
    success?: boolean;
    hostname?: string;
    action?: string;
    'error-codes'?: string[];
}

function normalizedHostname(value: string): string {
    const withoutScheme = value.replace(/^https?:\/\//i, '').split('/')[0] ?? value;
    return withoutScheme.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
}

async function findLocalNode() {
    const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821';
    const exact = await db.query.nodes.findFirst({ where: { domain } });
    if (exact) return exact;
    const fallback = await db.query.nodes.findMany({ limit: 2 });
    return fallback.length === 1 ? fallback[0] : undefined;
}

/** Turnstile is enabled only when the node has a complete key pair. */
export async function getTurnstileConfiguration(): Promise<TurnstileConfiguration | null> {
    try {
        const node = await findLocalNode();
        if (!node?.turnstileSiteKey || !node.turnstileSecretKey) return null;
        return {
            siteKey: node.turnstileSiteKey,
            secretKey: node.turnstileSecretKey,
            hostname: normalizedHostname(node.domain),
        };
    } catch (error) {
        console.error('Error fetching Turnstile configuration:', error);
        return null;
    }
}

export async function verifyTurnstileToken(
    token: string,
    options: TurnstileVerificationOptions,
): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
        const formData = new FormData();
        formData.append('secret', options.configuration.secretKey);
        formData.append('response', token);
        if (options.ip) formData.append('remoteip', options.ip);

        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData,
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!response.ok) {
            console.warn('[Auth] Turnstile Siteverify returned HTTP', response.status);
            return false;
        }

        const data = await response.json() as TurnstileSiteverifyResponse;
        const hostnameMatches = normalizedHostname(data.hostname ?? '')
            === normalizedHostname(options.configuration.hostname);
        const actionMatches = data.action === options.action;
        if (data.success !== true || !hostnameMatches || !actionMatches) {
            console.warn('[Auth] Turnstile verification rejected', {
                success: data.success === true,
                hostnameMatches,
                actionMatches,
                errorCodes: data['error-codes'] ?? [],
            });
            return false;
        }
        return true;
    } catch (error) {
        console.error('Turnstile verification error:', error);
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

export async function getTurnstileSiteKey(): Promise<string | null> {
    return (await getTurnstileConfiguration())?.siteKey ?? null;
}
