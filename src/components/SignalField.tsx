'use client';

import { useEffect, useRef } from 'react';

interface SignalPoint {
    restX: number;
    restY: number;
    x: number;
    y: number;
    radius: number;
    horizontalAmplitude: number;
    verticalAmplitude: number;
    horizontalSpeed: number;
    verticalSpeed: number;
    horizontalPhase: number;
    verticalPhase: number;
}

interface Signal {
    x: number;
    y: number;
    intensity: number;
}

interface Triangle {
    first: number;
    second: number;
    third: number;
}

const RANDOM_MULTIPLIER = BigInt('6364136223846793005');
const RANDOM_INCREMENT = BigInt('1442695040888963407');
const RANDOM_SHIFT = BigInt(11);
const UINT_53_MAX = 9_007_199_254_740_991;

function seededRandom(seed: bigint): () => number {
    let state = seed;
    return () => {
        state = BigInt.asUintN(
            64,
            state * RANDOM_MULTIPLIER + RANDOM_INCREMENT,
        );
        return Number(state >> RANDOM_SHIFT) / UINT_53_MAX;
    };
}

function distance(leftX: number, leftY: number, rightX: number, rightY: number): number {
    return Math.hypot(leftX - rightX, leftY - rightY);
}

function smoothFalloff(span: number, radius: number): number {
    const progress = Math.min(1, Math.max(0, span / radius));
    const eased = progress * progress * (3 - 2 * progress);
    return 1 - eased;
}

function connectionLimit(width: number, height: number): number {
    return Math.min(172, Math.max(138, Math.sqrt(width * height) / 3.8));
}

function createPoints(width: number, height: number): SignalPoint[] {
    const area = width * height;
    const count = Math.min(72, Math.max(40, Math.round(area / 7_600)));
    const random = seededRandom(BigInt('0x5A172026'));

    return Array.from({ length: count }, () => {
        const restX = random() * width;
        const restY = random() * height;
        return {
            restX,
            restY,
            x: restX,
            y: restY,
            horizontalAmplitude: 7 + random() * 12,
            verticalAmplitude: 7 + random() * 12,
            horizontalSpeed: 0.065 + random() * 0.055,
            verticalSpeed: 0.065 + random() * 0.055,
            horizontalPhase: random() * Math.PI * 2,
            verticalPhase: random() * Math.PI * 2,
            radius: 0.7 + random() * 1.2,
        };
    });
}

function createTriangles(points: SignalPoint[], limit: number): Triangle[] {
    const triangles = new Map<string, Triangle>();

    points.forEach((anchor, anchorIndex) => {
        const neighbors = points
            .map((point, index) => ({
                index,
                span: distance(anchor.restX, anchor.restY, point.restX, point.restY),
                angle: Math.atan2(point.restY - anchor.restY, point.restX - anchor.restX),
            }))
            .filter(({ index, span }) => index !== anchorIndex && span < limit)
            .sort((left, right) => left.span - right.span)
            .slice(0, 6)
            .sort((left, right) => left.angle - right.angle);

        if (neighbors.length < 2) return;

        neighbors.forEach((left, index) => {
            const right = neighbors[(index + 1) % neighbors.length];
            const leftPoint = points[left.index];
            const rightPoint = points[right.index];
            if (distance(
                leftPoint.restX,
                leftPoint.restY,
                rightPoint.restX,
                rightPoint.restY,
            ) >= limit) return;

            const [first, second, third] = [anchorIndex, left.index, right.index].sort((a, b) => a - b);
            const triangle = { first, second, third };
            triangles.set(`${first}:${second}:${third}`, triangle);
        });
    });

    return [...triangles.values()].sort((left, right) => (
        left.first - right.first
        || left.second - right.second
        || left.third - right.third
    ));
}

function updatePoints(points: SignalPoint[], elapsed: number): void {
    points.forEach((point) => {
        point.x = point.restX
            + Math.sin(elapsed * point.horizontalSpeed + point.horizontalPhase) * point.horizontalAmplitude;
        point.y = point.restY
            + Math.sin(elapsed * point.verticalSpeed + point.verticalPhase) * point.verticalAmplitude;
    });
}

function createSignals(elapsed: number, width: number, height: number): Signal[] {
    return [0, 6.8].map((offset, index) => {
        const shifted = elapsed + offset;
        const intensity = 0.48 + 0.24 * Math.sin(shifted * 0.32 + index * Math.PI);
        const horizontal = 0.5
            + 0.39 * Math.sin(shifted * (index === 0 ? 0.105 : 0.082) + index * 2.1);
        const vertical = 0.5
            + 0.40 * Math.sin(shifted * (index === 0 ? 0.078 : 0.112) + index * 1.3);
        return { x: width * horizontal, y: height * vertical, intensity };
    });
}

function strongestGlow(x: number, y: number, signals: Signal[], radius: number): number {
    return signals.reduce((strongest, signal) => Math.max(
        strongest,
        signal.intensity * smoothFalloff(distance(x, y, signal.x, signal.y), radius),
    ), 0);
}

export function SignalField() {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const context = canvas.getContext('2d');
        if (!context) return;

        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        let width = 0;
        let height = 0;
        let points: SignalPoint[] = [];
        let triangles: Triangle[] = [];
        let limit = 138;
        let animationFrame: number | null = null;
        let startedAt = performance.now();

        const draw = (now: number) => {
            const elapsed = reduceMotion.matches ? 0 : (now - startedAt) / 1_000;
            updatePoints(points, elapsed);
            const signals = createSignals(elapsed, width, height);

            context.clearRect(0, 0, width, height);
            context.fillStyle = 'rgb(5, 5, 5)';
            context.fillRect(0, 0, width, height);

            for (let leftIndex = 0; leftIndex < points.length; leftIndex += 1) {
                for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
                    const left = points[leftIndex];
                    const right = points[rightIndex];
                    const restSpan = distance(left.restX, left.restY, right.restX, right.restY);
                    if (restSpan >= limit) continue;

                    const midpointX = (left.x + right.x) / 2;
                    const midpointY = (left.y + right.y) / 2;
                    const glow = strongestGlow(midpointX, midpointY, signals, 285);
                    const closeness = 1 - restSpan / limit;
                    const opacity = 0.03 + closeness * 0.075 + glow * 0.12;

                    context.beginPath();
                    context.moveTo(left.x, left.y);
                    context.lineTo(right.x, right.y);
                    context.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
                    context.lineWidth = 0.65 + glow * 0.15;
                    context.stroke();
                }
            }

            if (!reduceMotion.matches) {
                triangles.forEach((triangle) => {
                    const first = points[triangle.first];
                    const second = points[triangle.second];
                    const third = points[triangle.third];
                    const centerX = (first.x + second.x + third.x) / 3;
                    const centerY = (first.y + second.y + third.y) / 3;
                    const glow = strongestGlow(centerX, centerY, signals, 260);
                    if (glow <= 0) return;

                    context.beginPath();
                    context.moveTo(first.x, first.y);
                    context.lineTo(second.x, second.y);
                    context.lineTo(third.x, third.y);
                    context.closePath();
                    context.fillStyle = `rgba(255, 255, 255, ${glow * 0.022})`;
                    context.fill();
                    context.strokeStyle = `rgba(255, 255, 255, ${glow * 0.16})`;
                    context.lineWidth = 0.55;
                    context.stroke();
                });
            }

            points.forEach((point) => {
                const glow = strongestGlow(point.x, point.y, signals, 225);
                const radius = point.radius + glow * 0.8;
                context.beginPath();
                context.arc(point.x, point.y, radius, 0, Math.PI * 2);
                context.fillStyle = `rgba(255, 255, 255, ${0.3 + glow * 0.55})`;
                context.fill();
            });
        };

        const animate = (now: number) => {
            draw(now);
            if (!reduceMotion.matches && !document.hidden) {
                animationFrame = window.requestAnimationFrame(animate);
            } else {
                animationFrame = null;
            }
        };

        const start = () => {
            if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
            animationFrame = null;
            draw(performance.now());
            if (!reduceMotion.matches && !document.hidden) {
                animationFrame = window.requestAnimationFrame(animate);
            }
        };

        const resize = () => {
            const bounds = container.getBoundingClientRect();
            width = Math.max(1, bounds.width);
            height = Math.max(1, bounds.height);
            const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(width * pixelRatio);
            canvas.height = Math.round(height * pixelRatio);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            points = createPoints(width, height);
            limit = connectionLimit(width, height);
            triangles = createTriangles(points, limit);
            startedAt = performance.now();
            start();
        };

        const handleVisibility = () => start();
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        reduceMotion.addEventListener('change', start);
        document.addEventListener('visibilitychange', handleVisibility);
        resize();

        return () => {
            if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
            resizeObserver.disconnect();
            reduceMotion.removeEventListener('change', start);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, []);

    return (
        <div ref={containerRef} className="signal-field" aria-hidden="true">
            <canvas ref={canvasRef} />
            <div className="signal-field-scrim" />
        </div>
    );
}
