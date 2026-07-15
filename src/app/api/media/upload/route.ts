import { NextRequest, NextResponse } from 'next/server';
import { db, media } from '@/db';
import { requireAuth } from '@/lib/auth';
import { getStorageSession, createStorageSession } from '@/lib/storage/session';
import { uploadWithStorageCredentials } from '@/lib/storage/s3';
import { v4 as uuidv4 } from 'uuid';
import { getMaxMediaSize, getMediaKind } from '@/lib/media/upload-policy';

export async function POST(req: NextRequest) {
    try {
        const user = await requireAuth();

        const formData = await req.formData();
        const file = formData.get('file') as File | null;
        const altText = (formData.get('alt') as string | null) || null;
        const password = formData.get('password') as string | null;

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        // Validate file type
        const mediaKind = getMediaKind(file.type);

        if (mediaKind === 'unsupported') {
            return NextResponse.json({
                error: 'Invalid file type. Upload an image, video, MP3, M4A, AAC, WAV, OGG, or FLAC file.'
            }, { status: 400 });
        }

        // Validate file size based on type
        const maxSize = getMaxMediaSize(file.type);
        if (maxSize !== null && file.size > maxSize) {
            return NextResponse.json({
                error: `File too large. Maximum size: ${mediaKind === 'image' ? '10MB' : '100MB'}`
            }, { status: 400 });
        }

        // Check if user has S3 storage configured
        if (!user.storageProvider || !user.storageAccessKeyEncrypted || !user.storageSecretKeyEncrypted) {
            return NextResponse.json({ 
                error: 'Connect your storage before uploading media.',
                code: 'STORAGE_NOT_CONFIGURED',
            }, { status: 409 });
        }

        const storageSession =
            (await getStorageSession(user.id)) ||
            (password ? await createStorageSession(user, password) : null);

        if (!storageSession) {
            return NextResponse.json({
                error: 'Upload session expired. Please sign in again.'
            }, { status: 401 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const filename = `${uuidv4()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;

        // Upload to user's own S3-compatible storage
        const uploadResult = await uploadWithStorageCredentials(
            buffer,
            filename,
            file.type,
            storageSession.provider,
            storageSession.endpoint,
            storageSession.publicBaseUrl,
            storageSession.region,
            storageSession.bucket,
            storageSession.accessKeyId,
            storageSession.secretAccessKey
        );

        // Store media record with S3 URL
        if (db) {
            const [mediaRecord] = await db.insert(media).values({
                userId: user.id,
                postId: null,
                url: uploadResult.url,
                altText,
                mimeType: file.type,
                width: 0, // TODO: Get actual dimensions
                height: 0,
            }).returning();

            return NextResponse.json({
                success: true,
                media: mediaRecord,
                url: uploadResult.url,
                key: uploadResult.key,
            });
        }

        return NextResponse.json({
            success: true,
            url: uploadResult.url,
            key: uploadResult.key,
        });

    } catch (error) {
        if (error instanceof Error && error.message === 'Authentication required') {
            return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
        }
        if (error instanceof Error && error.message === 'Invalid storage password') {
            return NextResponse.json({
                error: 'Incorrect password. Please try again.'
            }, { status: 401 });
        }
        if (error instanceof Error && error.message.includes('Storage')) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Upload error:', error);
        return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }
}
