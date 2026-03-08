import { NextResponse } from 'next/server';
import { db, nodes } from '@/db';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';

    // 1. Try exact match
    let node = await db.query.nodes.findFirst({
      where: eq(nodes.domain, domain),
    });

    // 2. Fallback: If not found, check if there is exactly ONE node in the system
    if (!node) {
      const allNodes = await db.query.nodes.findMany({ limit: 2 });
      if (allNodes.length === 1) {
        node = allNodes[0];
      }
    }

    // Check if we have logo data
    if (!node?.logoData) {
      return NextResponse.json({ error: 'Logo not found' }, { status: 404 });
    }

    // Parse the data URL to extract MIME type and base64 data
    const dataUrl = node.logoData;
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);

    if (!match) {
      // If not a proper data URL, try to serve as-is (backward compatibility)
      return NextResponse.json({ error: 'Invalid logo data' }, { status: 500 });
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // Return the image with proper headers
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Content-Length': buffer.length.toString(),
      },
    });

  } catch (error) {
    console.error('Logo serve error:', error);
    return NextResponse.json({ error: 'Failed to serve logo' }, { status: 500 });
  }
}
