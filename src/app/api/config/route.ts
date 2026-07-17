import { NextResponse } from 'next/server';
import { requireLocalNodeNsfwClassification } from '@/lib/node/local-node';

export async function GET() {
  const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821';
  try {
    const isNsfw = await requireLocalNodeNsfwClassification();
    return NextResponse.json({
      domain,
      isNsfw,
      classificationKnown: true,
    });
  } catch (error) {
    console.error('Runtime config lookup failed:', error);
    // The client must never interpret an unavailable classification as safe.
    return NextResponse.json({
      domain,
      isNsfw: true,
      classificationKnown: false,
    }, { status: 503 });
  }
}
