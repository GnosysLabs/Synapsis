import { NextResponse } from 'next/server';

import { requireAuth } from '@/lib/auth';
import { retryAccountMoveForUser } from '@/lib/account/move-delivery';

export async function POST() {
  try {
    const user = await requireAuth();
    if (!user.movedFrom) {
      return NextResponse.json({ error: 'This account was not imported from another node' }, { status: 400 });
    }
    const confirmed = await retryAccountMoveForUser(user.id);
    if (!confirmed) {
      return NextResponse.json({
        success: true,
        pending: true,
        message: 'The old node is still offline. Cleanup remains queued and will retry automatically.',
      }, { status: 202 });
    }

    return NextResponse.json({
      success: true,
      sourceDataDeleted: true,
      usernameReserved: true,
      message: 'The old node deleted the source data and permanently reserved the username.',
    });
  } catch (error) {
    console.error('Move finalization error:', error);
    return NextResponse.json({
      error: 'Source cleanup could not be retried right now. The move is complete and automatic retries remain queued.',
    }, { status: 500 });
  }
}
