interface BlurredImageProps {
    src: string;
    alt: string;
}

export default function BlurredImage({ src, alt }: BlurredImageProps) {
    return (
        <div className="blurred-image-container">
            <Image
                unoptimized
                referrerPolicy="no-referrer"
                src={src}
                alt=""
                width={1200}
                height={800}
                aria-hidden="true"
                loading="lazy"
                className="blurred-image-bg"
            />
            <Image
                unoptimized
                referrerPolicy="no-referrer"
                src={src}
                alt={alt}
                width={1200}
                height={800}
                loading="lazy"
                className="blurred-image-main"
            />
        </div>
    );
}
import Image from 'next/image';
