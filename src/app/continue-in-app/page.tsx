import type { Metadata } from 'next';
import { IosAppHandoff } from '@/components/IosAppHandoff';

export const metadata: Metadata = {
    title: 'Continue in Synapsis',
    robots: { index: false, follow: false },
};

export default function ContinueInAppPage() {
    return <IosAppHandoff />;
}
