export type ToastPresentationType = 'success' | 'error' | 'info';

export function getToastBackground(type: ToastPresentationType): string {
    if (type === 'error') return 'var(--error, #ef4444)';
    if (type === 'success') return 'var(--accent)';
    return 'var(--background-secondary)';
}
