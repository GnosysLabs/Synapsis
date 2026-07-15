'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, TextareaHTMLAttributes } from 'react';

const AutoTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function AutoTextarea(props, forwardedRef) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(forwardedRef, () => textareaRef.current as HTMLTextAreaElement, []);

    const adjustHeight = () => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${textarea.scrollHeight}px`;
        }
    };

    useEffect(() => {
        adjustHeight();
    }, [props.value]);

    return (
        <textarea
            {...props}
            ref={textareaRef}
            // Ensure 1 row minimum and hide scrollbars to prevent jitter
            rows={props.rows || 1}
            onInput={(e) => {
                adjustHeight();
                props.onInput?.(e);
            }}
            style={{
                ...props.style,
                resize: 'none',
                overflow: 'hidden',
                minHeight: 'auto', // Override specific min-heights if they conflict
            }}
        />
    );
});

export default AutoTextarea;
