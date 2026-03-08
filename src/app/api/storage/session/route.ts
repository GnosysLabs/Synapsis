import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, verifyPassword } from '@/lib/auth';
import { clearStorageSession, createStorageSession } from '@/lib/storage/session';

const bodySchema = z.object({
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const body = await request.json();
    const data = bodySchema.parse(body);

    if (!user.passwordHash) {
      return NextResponse.json({ error: 'Account has no password set' }, { status: 400 });
    }

    const isValid = await verifyPassword(data.password, user.passwordHash);

    if (!isValid) {
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }

    await createStorageSession(user, data.password);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid input', details: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    console.error('Storage session error:', error);
    return NextResponse.json({ error: 'Failed to refresh upload session' }, { status: 500 });
  }
}

export async function DELETE() {
  await clearStorageSession();
  return NextResponse.json({ success: true });
}
