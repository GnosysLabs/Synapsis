'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getPostPath } from '@/lib/utils/handle';

export default function PostRedirect() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;

    useEffect(() => {
        const fetchAndRedirect = async () => {
            try {
                const res = await fetch(`/api/posts/${id}`);
                if (!res.ok) {
                    router.push('/');
                    return;
                }
                const data = await res.json();
                router.push(getPostPath(
                    data.post.author.handle,
                    id,
                    data.post.author.nodeDomain || data.post.nodeDomain,
                ));
            } catch {
                router.push('/');
            }
        };

        fetchAndRedirect();
    }, [id, router]);

    return (
        <div style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--foreground-tertiary)',
        }}>
            Loading...
        </div>
    );
}
