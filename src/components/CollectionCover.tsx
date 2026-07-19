'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Images } from 'lucide-react';

import { isTrustedFederationMediaUrl } from '@/lib/utils/federation';

interface CollectionCoverProps {
  coverUrl?: string | null;
  previewImages?: string[];
  title: string;
  className?: string;
}

export function CollectionCover({ coverUrl, previewImages = [], title, className = '' }: CollectionCoverProps) {
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const trustedCover = coverUrl && isTrustedFederationMediaUrl(coverUrl) ? coverUrl : null;
  const trustedPreviews = previewImages
    .filter((value) => isTrustedFederationMediaUrl(value));
  // An explicit cover is the complete cover, not the first tile in an
  // automatically generated collage. Only fall back to post media if the
  // chosen cover cannot be loaded.
  const candidates = trustedCover && !failedImages.has(trustedCover)
    ? [trustedCover]
    : trustedPreviews.filter((url) => !failedImages.has(url));
  const images = [...new Set(candidates)].slice(0, 4);

  if (images.length === 0) {
    return (
      <div className={`collection-cover collection-cover-empty ${className}`}>
        <Images size={28} aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className={`collection-cover collection-cover-${Math.min(images.length, 4)} ${className}`}>
      {images.map((url, index) => (
        <Image
          key={url}
          unoptimized
          src={url}
          alt={index === 0 ? `${title} cover` : ''}
          width={640}
          height={360}
          loading="lazy"
          onError={() => setFailedImages((current) => {
            if (current.has(url)) return current;
            const next = new Set(current);
            next.add(url);
            return next;
          })}
        />
      ))}
    </div>
  );
}
