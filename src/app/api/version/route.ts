import { NextResponse } from 'next/server';
import { getCurrentBuildInfo } from '@/lib/version';

export async function GET() {
    return NextResponse.json(getCurrentBuildInfo());
}
