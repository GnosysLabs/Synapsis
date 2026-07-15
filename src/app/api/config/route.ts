import { NextResponse } from 'next/server';
import { db } from '@/db';

export async function GET() {
  const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821';
  let isNsfw = false;

  try {
    let node = await db.query.nodes.findFirst({ where: { domain } });
    if (!node) {
      const nodes = await db.query.nodes.findMany({ limit: 2 });
      if (nodes.length === 1) node = nodes[0];
    }
    isNsfw = node?.isNsfw === true;
  } catch (error) {
    console.error('Runtime config lookup failed:', error);
  }

  return NextResponse.json({
    domain,
    isNsfw,
  });
}
