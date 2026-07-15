'use client';

import { useRef, useState } from 'react';
import { Music2, Pause, Play } from 'lucide-react';

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

    const togglePlayback = async () => {
        const audio = audioRef.current;
        if (!audio) return;
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
                preload="metadata"
                onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
                onDurationChange={(event) => setDuration(event.currentTarget.duration)}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
            />
            <button
                type="button"
                className="audio-player-toggle"
                onClick={togglePlayback}
                aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
            >
                {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <div className="audio-player-body">
                <div className="audio-player-title"><Music2 size={15} /> {title}</div>
                <input
                    className="audio-player-progress"
                    type="range"
                    min={0}
                    max={duration || 0}
                    step="0.1"
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(event) => seek(Number(event.target.value))}
                    aria-label={`Seek ${title}`}
                />
                <div className="audio-player-time">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                </div>
            </div>
        </div>
    );
}
