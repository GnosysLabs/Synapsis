import { NextRequest, NextResponse } from 'next/server';
import { db, nodes } from '@/db';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth/admin';
import { getVersionedNodeAssetUrl } from '@/lib/node/assets';

// Logo constraints
const MAX_LOGO_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_LOGO_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

// Favicon constraints
const MAX_FAVICON_SIZE = 500 * 1024; // 500KB
const ALLOWED_FAVICON_TYPES = [
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/svg+xml',
];

// Map file extensions to MIME types for validation
const MIME_TYPE_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const type = formData.get('type') as 'logo' | 'favicon' | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!type || (type !== 'logo' && type !== 'favicon')) {
      return NextResponse.json({ error: 'Invalid type. Must be "logo" or "favicon"' }, { status: 400 });
    }

    // Determine constraints based on type
    const isLogo = type === 'logo';
    const maxSize = isLogo ? MAX_LOGO_SIZE : MAX_FAVICON_SIZE;
    const allowedTypes = isLogo ? ALLOWED_LOGO_TYPES : ALLOWED_FAVICON_TYPES;
    const typeName = isLogo ? 'Logo' : 'Favicon';

    // Validate file size
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `${typeName} too large. Maximum size: ${isLogo ? '2MB' : '500KB'}` },
        { status: 400 }
      );
    }

    // Validate MIME type
    let mimeType = file.type;
    
    // Handle cases where browser might not set correct MIME type
    if (!mimeType || mimeType === 'application/octet-stream') {
      const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
      mimeType = MIME_TYPE_MAP[ext] || '';
    }

    // Special handling for .ico files
    if (file.name.toLowerCase().endsWith('.ico')) {
      mimeType = 'image/x-icon';
    }

    if (!allowedTypes.includes(mimeType)) {
      const allowedList = isLogo 
        ? 'PNG, JPG, GIF, WebP, SVG'
        : 'ICO, PNG, SVG';
      return NextResponse.json(
        { error: `Invalid file type for ${typeName.toLowerCase()}. Allowed: ${allowedList}` },
        { status: 400 }
      );
    }

    // Convert file to base64
    const buffer = Buffer.from(await file.arrayBuffer());
    const base64Data = buffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    // Get current node
    const domain = process.env.NEXT_PUBLIC_NODE_DOMAIN || 'localhost:3000';
    let node = await db.query.nodes.findFirst({
      where: eq(nodes.domain, domain),
    });

    // Fallback: If not found, check if there is exactly ONE node in the system
    if (!node) {
      const allNodes = await db.query.nodes.findMany({ limit: 2 });
      if (allNodes.length === 1) {
        node = allNodes[0];
      }
    }

    if (!node) {
      return NextResponse.json({ error: 'Node not found' }, { status: 404 });
    }

    // Update the appropriate field
    const updatedAt = new Date();
    const assetUrl = isLogo
      ? getVersionedNodeAssetUrl('/api/node/logo', updatedAt)
      : getVersionedNodeAssetUrl('/api/node/favicon', updatedAt);

    const updateData = isLogo
      ? { logoData: dataUrl, logoUrl: assetUrl, updatedAt }
      : { faviconData: dataUrl, faviconUrl: assetUrl, updatedAt };

    await db.update(nodes)
      .set(updateData)
      .where(eq(nodes.id, node.id));

    return NextResponse.json({
      success: true,
      url: assetUrl,
      type,
      size: file.size,
    });

  } catch (error) {
    if (error instanceof Error && error.message === 'Admin authentication required') {
      return NextResponse.json({ error: 'Admin authentication required' }, { status: 401 });
    }
    console.error('Node upload error:', error);
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
