export function registrationDisplayName(handle: string, email: string, displayName?: string): string {
    const trimmedDisplayName = displayName?.trim();
    if (!trimmedDisplayName || trimmedDisplayName.toLowerCase() === email.trim().toLowerCase()) {
        return handle;
    }
    return trimmedDisplayName;
}
