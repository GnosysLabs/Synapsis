/**
 * Swarm Chat Deletion Inbox
 * 
 * Legacy endpoint retained only to reject remote destructive requests.
 */

import { NextResponse } from 'next/server';

export async function POST() {
  // A remote participant may delete only its own local copy. It never has
  // authority to erase the recipient-owned conversation or message history.
  return NextResponse.json({
    error: 'Remote conversation deletion is not supported',
    code: 'REMOTE_CONVERSATION_DELETE_UNSUPPORTED',
  }, { status: 410 });
}
