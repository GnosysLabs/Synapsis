import { AuthScreen } from '@/components/AuthScreen';
import { headers } from 'next/headers';
import { isIPhoneUserAgent } from '@/lib/platform/ios-web-funnel';

type LoginSearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: { searchParams: LoginSearchParams }) {
    const [params, requestHeaders] = await Promise.all([searchParams, headers()]);
    const requestedMode = firstValue(params.mode);
    const isIPhone = firstValue(params.app) === 'ios'
        || isIPhoneUserAgent(requestHeaders.get('user-agent'));
    const initialMode = isIPhone
        ? 'register'
        : requestedMode === 'register' ? 'register' : 'login';

    return <AuthScreen iosFunnel={isIPhone} initialMode={initialMode} />;
}
