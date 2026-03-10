import { users } from '@/db';

type NotificationTargetUser = Pick<
  typeof users.$inferSelect,
  'handle' | 'displayName' | 'avatarUrl' | 'isBot'
>;

export function buildNotificationTarget(
  user: NotificationTargetUser,
  nodeDomain: string | null = null
) {
  return {
    targetHandle: user.handle,
    targetDisplayName: user.displayName || user.handle,
    targetAvatarUrl: user.avatarUrl || null,
    targetNodeDomain: nodeDomain,
    targetIsBot: user.isBot,
  };
}
