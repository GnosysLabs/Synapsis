import { NextResponse } from 'next/server';

/**
 * Health check endpoint for systemd and external monitoring
 * Returns 200 OK when the application is running properly
 */
export async function GET() {
    return NextResponse.json(
        {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'synapsis',
        },
        { status: 200 }
    );
}
