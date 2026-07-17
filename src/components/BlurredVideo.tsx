'use client';

import { useRef, useEffect, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';

interface BlurredVideoProps {
    src: string;
}

export function formatVideoTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return '0:00';
    }

    const wholeSeconds = Math.floor(seconds);
    const minutes = Math.floor(wholeSeconds / 60);
    const remainingSeconds = wholeSeconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export default function BlurredVideo({ src }: BlurredVideoProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mainVideoRef = useRef<HTMLVideoElement>(null);
    const bgVideoRef = useRef<HTMLVideoElement>(null);
    const [isLoaded, setIsLoaded] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [isMuted, setIsMuted] = useState(true);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    useEffect(() => {
        const mainVideo = mainVideoRef.current;
        const bgVideo = bgVideoRef.current;

        if (mainVideo && bgVideo) {
            const syncTime = () => {
                if (Math.abs(mainVideo.currentTime - bgVideo.currentTime) > 0.1) {
                    bgVideo.currentTime = mainVideo.currentTime;
                }
            };

            const handlePlay = () => {
                setIsPlaying(true);
                bgVideo.play().catch(() => {});
            };
            const handlePause = () => {
                setIsPlaying(false);
                bgVideo.pause();
            };
            const handleLoaded = () => {
                setIsLoaded(true);
                setDuration(Number.isFinite(mainVideo.duration) ? mainVideo.duration : 0);
                setCurrentTime(mainVideo.currentTime);
                setIsPlaying(!mainVideo.paused);
            };
            const handleTimeUpdate = () => {
                setCurrentTime(mainVideo.currentTime);
                syncTime();
            };
            const handleDurationChange = () => {
                setDuration(Number.isFinite(mainVideo.duration) ? mainVideo.duration : 0);
            };
            const handleVolumeChange = () => setIsMuted(mainVideo.muted);

            mainVideo.addEventListener('seeked', syncTime);
            mainVideo.addEventListener('play', handlePlay);
            mainVideo.addEventListener('pause', handlePause);
            mainVideo.addEventListener('loadeddata', handleLoaded);
            mainVideo.addEventListener('timeupdate', handleTimeUpdate);
            mainVideo.addEventListener('durationchange', handleDurationChange);
            mainVideo.addEventListener('volumechange', handleVolumeChange);

            return () => {
                mainVideo.removeEventListener('seeked', syncTime);
                mainVideo.removeEventListener('play', handlePlay);
                mainVideo.removeEventListener('pause', handlePause);
                mainVideo.removeEventListener('loadeddata', handleLoaded);
                mainVideo.removeEventListener('timeupdate', handleTimeUpdate);
                mainVideo.removeEventListener('durationchange', handleDurationChange);
                mainVideo.removeEventListener('volumechange', handleVolumeChange);
            };
        }
    }, [src]);

    const togglePlayback = () => {
        const mainVideo = mainVideoRef.current;
        if (!mainVideo) return;

        if (mainVideo.paused) {
            mainVideo.play().catch(() => {});
        } else {
            mainVideo.pause();
        }
    };

    const toggleMuted = () => {
        const mainVideo = mainVideoRef.current;
        if (mainVideo) {
            mainVideo.muted = !mainVideo.muted;
        }
    };

    const seek = (value: number) => {
        const mainVideo = mainVideoRef.current;
        const bgVideo = bgVideoRef.current;
        if (!mainVideo) return;

        const nextTime = Math.min(Math.max(value, 0), duration || 0);
        mainVideo.currentTime = nextTime;
        if (bgVideo) {
            bgVideo.currentTime = nextTime;
        }
        setCurrentTime(nextTime);
    };

    return (
        <div
            ref={containerRef}
            className="blurred-video-container"
            onClick={(event) => event.stopPropagation()}
        >
            {/* Background blurred video */}
            <video
                ref={bgVideoRef}
                src={src}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                className="blurred-video-bg"
                aria-hidden="true"
                style={{ opacity: isLoaded ? 1 : 0 }}
            />
            {/* Main video */}
            <video
                ref={mainVideoRef}
                src={src}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                className="blurred-video-main"
                onClick={togglePlayback}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        togglePlayback();
                    }
                }}
                tabIndex={0}
                aria-label="Video"
                title="Play or pause video"
            />
            <div className="video-player-controls" aria-label="Video controls">
                <button
                    type="button"
                    className="video-player-control-button"
                    onClick={togglePlayback}
                    aria-label={isPlaying ? 'Pause video' : 'Play video'}
                    title={isPlaying ? 'Pause' : 'Play'}
                >
                    {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
                </button>
                <span className="video-player-time">{formatVideoTime(currentTime)}</span>
                <input
                    className="video-player-scrubber"
                    type="range"
                    min="0"
                    max={duration || 0}
                    step="0.1"
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(event) => seek(Number(event.currentTarget.value))}
                    aria-label="Seek video"
                    aria-valuetext={`${formatVideoTime(currentTime)} of ${formatVideoTime(duration)}`}
                    disabled={!duration}
                />
                <span className="video-player-time">{formatVideoTime(duration)}</span>
                <button
                    type="button"
                    className="video-player-control-button"
                    onClick={toggleMuted}
                    aria-label={isMuted ? 'Unmute video' : 'Mute video'}
                    title={isMuted ? 'Unmute' : 'Mute'}
                >
                    {isMuted ? <VolumeX size={19} /> : <Volume2 size={19} />}
                </button>
            </div>
        </div>
    );
}
