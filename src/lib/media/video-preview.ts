const FALLBACK_PREVIEW_TIME_SECONDS = 0.001;
const PREFERRED_PREVIEW_TIME_SECONDS = 1;

interface VideoPreviewTarget {
    currentTime: number;
    duration: number;
}

export function getVideoPreviewTime(duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0) {
        return FALLBACK_PREVIEW_TIME_SECONDS;
    }

    return Math.min(PREFERRED_PREVIEW_TIME_SECONDS, duration / 2);
}

export function primeVideoPreviewFrame(video: VideoPreviewTarget): void {
    video.currentTime = getVideoPreviewTime(video.duration);
}
