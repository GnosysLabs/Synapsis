export function configuredAdminEmails(value = process.env.ADMIN_EMAILS): string[] {
    return [...new Set(
        (value || '')
            .split(',')
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
    )];
}

export function isConfiguredAdminEmail(
    email: string | null | undefined,
    value = process.env.ADMIN_EMAILS
): boolean {
    if (!email) return false;
    return configuredAdminEmails(value).includes(email.toLowerCase());
}
