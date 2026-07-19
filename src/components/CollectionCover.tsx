'use client';

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
  const candidates = [coverUrl, ...previewImages]
    .filter((value): value is string => Boolean(value))
    .filter((value) => isTrustedFederationMediaUrl(value));
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
        />
      ))}
    </div>
  );
}
