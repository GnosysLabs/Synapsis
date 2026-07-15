import { NextResponse } from 'next/server';

import { getNodePublicKey } from '@/lib/swarm/node-keys';

export async function GET() {
  try {
    const publicKey = await getNodePublicKey();
    if (!publicKey) {
      return NextResponse.json({ error: 'Node public key is unavailable' }, { status: 503 });
    }

    return NextResponse.json({
      domain: process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:43821',
      publicKey,
    }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Node public key error:', error);
    return NextResponse.json({ error: 'Node public key is unavailable' }, { status: 503 });
  }
}
