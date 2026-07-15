import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { revokeToken } from '@/lib/stuffbox/client';
import {
  getStuffboxConnection,
  readStuffboxRefreshToken,
  removeStuffboxConnection,
} from '@/lib/stuffbox/tokens';

export async function POST() {
  try {
    const user = await requireAuth();
    const connection = await getStuffboxConnection(user.id);
    if (connection) {
      try {
        await revokeToken(connection.baseUrl, readStuffboxRefreshToken(connection));
      } catch (error) {
        console.warn('Stuffbox token revocation failed; removing local connection:', error);
      }
      await removeStuffboxConnection(user.id);
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Stuffbox disconnect error:', error);
    return NextResponse.json({ error: 'Unable to disconnect Stuffbox' }, { status: 500 });
  }
}
