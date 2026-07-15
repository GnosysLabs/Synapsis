import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, users } from '@/db';
import { requireAuth, verifyPassword } from '@/lib/auth';
import { encryptPrivateKey, serializeEncryptedKey } from '@/lib/crypto/private-key';
import { testS3Credentials, type StorageProvider } from '@/lib/storage/s3';
import { createStorageSession } from '@/lib/storage/session';
import { configuredStuffboxUrl } from '@/lib/stuffbox/client';
import { getStuffboxConnection } from '@/lib/stuffbox/tokens';

const configurationSchema = z.object({
  password: z.string().min(1),
  provider: z.enum(['s3', 'r2', 'b2', 'wasabi', 'contabo']),
  endpoint: z.string().trim().nullable().optional(),
  publicBaseUrl: z.string().trim().nullable().optional(),
  region: z.string().trim().min(2),
  bucket: z.string().trim().min(3),
  accessKey: z.string().min(10),
  secretKey: z.string().min(10),
});

export async function GET() {
  try {
    const user = await requireAuth();
    const stuffbox = await getStuffboxConnection(user.id);
    return NextResponse.json({
      provider: stuffbox ? 'stuffbox' : user.storageProvider ? 's3' : null,
      stuffboxAvailable: Boolean(configuredStuffboxUrl()),
      stuffboxBaseUrl: stuffbox?.baseUrl ?? null,
      s3Provider: user.storageProvider ?? null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    console.error('Storage status error:', error);
    return NextResponse.json({ error: 'Failed to load storage status' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAuth();
    const data = configurationSchema.parse(await request.json());

    if (!user.passwordHash || !(await verifyPassword(data.password, user.passwordHash))) {
      return NextResponse.json({ error: 'Incorrect account password' }, { status: 401 });
    }

    const storageTest = await testS3Credentials(
      data.endpoint || null,
      data.region,
      data.bucket,
      data.accessKey,
      data.secretKey
    );

    if (!storageTest.success) {
      return NextResponse.json(
        { error: `Storage connection failed: ${storageTest.error}` },
        { status: 400 }
      );
    }

    const storageProvider = data.provider as StorageProvider;
    const storageAccessKeyEncrypted = serializeEncryptedKey(encryptPrivateKey(data.accessKey, data.password));
    const storageSecretKeyEncrypted = serializeEncryptedKey(encryptPrivateKey(data.secretKey, data.password));
    const storageValues = {
      storageProvider,
      storageEndpoint: data.endpoint || null,
      storagePublicBaseUrl: data.publicBaseUrl || null,
      storageRegion: data.region,
      storageBucket: data.bucket,
      storageAccessKeyEncrypted,
      storageSecretKeyEncrypted,
    };

    await db.update(users).set(storageValues).where(eq(users.id, user.id));
    await createStorageSession({ ...user, ...storageValues }, data.password);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid storage configuration', details: error.issues }, { status: 400 });
    }
    if (error instanceof Error && error.message === 'Authentication required') {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    console.error('Storage configuration error:', error);
    return NextResponse.json({ error: 'Failed to configure storage' }, { status: 500 });
  }
}
