interface BlurredImageProps {
    src: string;
    alt: string;
}

export default function BlurredImage({ src, alt }: BlurredImageProps) {
    return (
        <div className="blurred-image-container">
            <img
                src={src}
                alt=""
                aria-hidden="true"
                loading="lazy"
                className="blurred-image-bg"
            />
            <img
                src={src}
                alt={alt}
                loading="lazy"
                className="blurred-image-main"
            />
        </div>
    );
}
