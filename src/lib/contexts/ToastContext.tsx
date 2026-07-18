'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { useAccentColor } from './AccentColorContext';
import { getToastBackground, type ToastPresentationType } from '@/lib/ui/toast-presentation';

type ToastType = ToastPresentationType;

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    toasts: Toast[];
    showToast: (message: string, type?: ToastType) => void;
    removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

// Check if a color is light (needs dark text)
function isLightColor(hex: string): boolean {
    const color = hex.replace('#', '');
    const r = parseInt(color.slice(0, 2), 16);
    const g = parseInt(color.slice(2, 4), 16);
    const b = parseInt(color.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6;
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = useCallback((message: string, type: ToastType = 'info') => {
        const id = Math.random().toString(36).slice(2);
        setToasts(prev => [...prev, { id, message, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 3500);
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ toasts, showToast, removeToast }}>
            {children}
            <ToastContainer toasts={toasts} removeToast={removeToast} />
        </ToastContext.Provider>
    );
}

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
}

function ToastContainer({ toasts, removeToast }: { toasts: Toast[]; removeToast: (id: string) => void }) {
    const { accentColor } = useAccentColor();
    const needsDarkText = isLightColor(accentColor);
    
    if (toasts.length === 0) return null;

    return (
        <div style={{
            position: 'fixed',
            top: 'calc(24px + env(safe-area-inset-top))',
            right: '24px',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            pointerEvents: 'none',
        }}>
            {toasts.map(toast => (
                <div
                    key={toast.id}
                    onClick={() => removeToast(toast.id)}
                    style={{
                        pointerEvents: 'auto',
                        cursor: 'pointer',
                        padding: '12px 16px',
                        borderRadius: '8px',
                        background: getToastBackground(toast.type),
                        color: toast.type === 'error'
                            ? '#fff'
                            : toast.type === 'success' 
                                ? (needsDarkText ? '#000' : '#fff')
                                : 'var(--foreground)',
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                        fontSize: '14px',
                        fontWeight: 500,
                        maxWidth: '320px',
                        animation: 'toastSlideIn 0.2s ease-out',
                        border: '1px solid var(--border)',
                    }}
                >
                    {toast.message}
                </div>
            ))}
            <style jsx global>{`
                @keyframes toastSlideIn {
                    from {
                        opacity: 0;
                        transform: translateX(100%);
                    }
                    to {
                        opacity: 1;
                        transform: translateX(0);
                    }
                }
            `}</style>
        </div>
    );
}
