import { NextRequest, NextResponse } from 'next/server';
import { db, media } from '@/db';
import { requireAuth } from '@/lib/auth';
import { uploadToUserStorage } from '@/lib/storage/s3';
import { v4 as uuidv4 } from 'uuid';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB for images
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB for videos
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

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
        const isImage = ALLOWED_IMAGE_TYPES.includes(file.type);
        const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);
        
        if (!isImage && !isVideo) {
            return NextResponse.json({
                error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP, MP4, WebM, MOV'
            }, { status: 400 });
        }

        // Validate file size based on type
        const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
        if (file.size > maxSize) {
            return NextResponse.json({
                error: `File too large. Maximum size: ${isVideo ? '100MB' : '10MB'}`
            }, { status: 400 });
        }

        // Check if user has S3 storage configured
        if (!user.storageProvider || !user.storageAccessKeyEncrypted || !user.storageSecretKeyEncrypted) {
            return NextResponse.json({ 
                error: 'Storage not configured. Please set up S3-compatible storage in your settings.'
            }, { status: 400 });
        }

        // Require password to decrypt storage credentials
        if (!password) {
            return NextResponse.json({ 
                error: 'Password required to upload media. Your storage credentials are encrypted and need your password to decrypt.'
            }, { status: 401 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const filename = `${uuidv4()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '')}`;

        // Upload to user's own S3-compatible storage
        const uploadResult = await uploadToUserStorage(
            buffer,
            filename,
            file.type,
            user.storageProvider as any,
            user.storageEndpoint,
            user.storagePublicBaseUrl,
            user.storageRegion || 'us-east-1',
            user.storageBucket || '',
            user.storageAccessKeyEncrypted,
            user.storageSecretKeyEncrypted,
            password
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
