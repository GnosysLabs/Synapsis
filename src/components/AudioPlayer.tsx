'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Music2, Pause, Play } from 'lucide-react';

import { loadAudioMetadata, type AudioTrackMetadata } from '@/lib/media/audio-metadata';

interface AudioPlayerProps {
    src: string;
    title?: string;
}

function formatTime(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ src, title = 'Audio track' }: AudioPlayerProps) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [resolvedMetadata, setResolvedMetadata] = useState<{
        src: string;
        metadata: AudioTrackMetadata;
        artworkUrl: string | null;
    } | null>(null);
    const metadataRequestSrcRef = useRef<string | null>(null);
    const artworkUrlRef = useRef<string | null>(null);

    useEffect(() => {
        metadataRequestSrcRef.current = null;
        return () => {
            metadataRequestSrcRef.current = null;
            if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current);
            artworkUrlRef.current = null;
        };
    }, [src]);

    const ensureMetadata = useCallback(() => {
        if (metadataRequestSrcRef.current === src) return;
        metadataRequestSrcRef.current = src;
        void loadAudioMetadata(src).then((nextMetadata) => {
            if (metadataRequestSrcRef.current !== src || !nextMetadata) return;
            const artworkUrl = nextMetadata.artwork
                ? URL.createObjectURL(new Blob(
                    [nextMetadata.artwork.data as BlobPart],
                    { type: nextMetadata.artwork.mimeType }
                ))
                : null;
            if (artworkUrlRef.current) URL.revokeObjectURL(artworkUrlRef.current);
            artworkUrlRef.current = artworkUrl;
            setResolvedMetadata({ src, metadata: nextMetadata, artworkUrl });
        });
    }, [src]);

    const metadata = resolvedMetadata?.src === src ? resolvedMetadata.metadata : null;
    const artworkUrl = resolvedMetadata?.src === src ? resolvedMetadata.artworkUrl : null;
    const displayTitle = metadata?.title || title;
    const detail = [metadata?.artist, metadata?.album].filter(Boolean).join(' · ');

    const togglePlayback = async () => {
        const audio = audioRef.current;
        if (!audio) return;
        ensureMetadata();
        if (audio.paused) {
            await audio.play();
        } else {
            audio.pause();
        }
    };

    const seek = (value: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = value;
        setCurrentTime(value);
    };

    return (
        <div className="audio-player" onClick={(event) => event.stopPropagation()}>
            <audio
                ref={audioRef}
                src={src}
                preload="none"
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                onDurationChange={(event) => setDuration(event.currentTarget.duration)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
            />
            {artworkUrl && (
                <Image
                    unoptimized
                    className="audio-player-artwork"
                    src={artworkUrl}
                    alt=""
                    width={64}
                    height={64}
                />
            )}
            <button
                type="button"
                className="audio-player-toggle"
                onClick={togglePlayback}
                aria-label={isPlaying ? `Pause ${displayTitle}` : `Play ${displayTitle}`}
            >
                {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <div className="audio-player-body">
                <div className="audio-player-title"><Music2 size={15} /> <span>{displayTitle}</span></div>
                {detail && <div className="audio-player-detail">{detail}</div>}
                <input
                    className="audio-player-progress"
                    type="range"
                    min={0}
                    max={duration || 0}
                    step="0.1"
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(event) => seek(Number(event.target.value))}
                    aria-label={`Seek ${displayTitle}`}
                />
                <div className="audio-player-time">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                </div>
            </div>
        </div>
    );
}
