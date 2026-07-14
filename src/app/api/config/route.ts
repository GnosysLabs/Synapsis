import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    domain: process.env.NEXT_PUBLIC_NODE_DOMAIN || process.env.NODE_DOMAIN || 'localhost:43821',
  });
}
