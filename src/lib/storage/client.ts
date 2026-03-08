export async function refreshStorageSession(password: string): Promise<void> {
    const res = await fetch('/api/storage/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(data.error || 'Failed to confirm password');
    }
}
