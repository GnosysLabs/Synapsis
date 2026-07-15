import { requireAuth } from '@/lib/auth';
import { users } from '@/db';
import { isConfiguredAdminEmail } from '@/lib/auth/admin-config';

type User = typeof users.$inferSelect;

export const isAdminUser = (user: User | null | undefined) => {
    if (!user) return false;
    return isConfiguredAdminEmail(user.email);
};

export async function requireAdmin(): Promise<User> {
    const user = await requireAuth();
    if (!isAdminUser(user)) {
        throw new Error('Admin required');
    }
    return user;
}
