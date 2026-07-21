import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { configuredStuffboxUrl } from '@/lib/stuffbox/client';
import { getStuffboxConnection } from '@/lib/stuffbox/tokens';
import { getOrRefreshStuffboxBadge } from '@/lib/stuffbox/badge-status';

export async function GET() {
  try {
    const user = await requireAuth();
    const stuffbox = await getStuffboxConnection(user.id);
    const stuffboxBadge = stuffbox ? await getOrRefreshStuffboxBadge(user) : null;
    return NextResponse.json({
      provider: stuffbox ? 'stuffbox' : null,
      stuffboxAvailable: Boolean(configuredStuffboxUrl()),
      stuffboxBaseUrl: stuffbox?.baseUrl ?? null,
      stuffboxUpdatedAt: stuffbox?.updatedAt.toISOString() ?? null,
      stuffboxBadge,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Storage status error:', error);
    return NextResponse.json({ error: 'Failed to load storage status' }, { status: 500 });
  }
}
