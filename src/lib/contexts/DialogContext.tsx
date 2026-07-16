'use client';

import {
    createContext,
    type FormEvent,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useId,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Info, MessageSquareText, X } from 'lucide-react';

type DialogTone = 'default' | 'danger';

interface BaseDialogOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    tone?: DialogTone;
}

export interface AlertDialogOptions extends BaseDialogOptions {
    dismissLabel?: string;
}

export interface ConfirmDialogOptions extends BaseDialogOptions {
    cancelLabel?: string;
}

export interface PromptDialogOptions extends BaseDialogOptions {
    cancelLabel?: string;
    initialValue?: string;
    inputLabel: string;
    placeholder?: string;
    required?: boolean;
}

interface DialogContextValue {
    showAlert: (options: AlertDialogOptions) => Promise<void>;
    showConfirm: (options: ConfirmDialogOptions) => Promise<boolean>;
    showPrompt: (options: PromptDialogOptions) => Promise<string | null>;
}

type DialogResult = boolean | string | null | undefined;

type DialogRequest =
    | {
        kind: 'alert';
        options: AlertDialogOptions;
        resolve: (value: DialogResult) => void;
    }
    | {
        kind: 'confirm';
        options: ConfirmDialogOptions;
        resolve: (value: DialogResult) => void;
    }
    | {
        kind: 'prompt';
        options: PromptDialogOptions;
        resolve: (value: DialogResult) => void;
    };

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
    const [activeDialog, setActiveDialog] = useState<DialogRequest | null>(null);
    const [promptValue, setPromptValue] = useState('');
    const activeDialogRef = useRef<DialogRequest | null>(null);
    const dialogQueueRef = useRef<DialogRequest[]>([]);
    const titleId = useId();
    const messageId = useId();
    const promptId = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    const primaryActionRef = useRef<HTMLButtonElement>(null);
    const promptInputRef = useRef<HTMLInputElement>(null);

    const showNextDialog = useCallback(() => {
        if (activeDialogRef.current || dialogQueueRef.current.length === 0) return;
        const nextDialog = dialogQueueRef.current.shift()!;
        activeDialogRef.current = nextDialog;
        setPromptValue(nextDialog.kind === 'prompt' ? nextDialog.options.initialValue || '' : '');
        setActiveDialog(nextDialog);
    }, []);

    const enqueueDialog = useCallback((dialog: DialogRequest) => {
        dialogQueueRef.current.push(dialog);
        showNextDialog();
    }, [showNextDialog]);

    const finishDialog = useCallback((result: DialogResult) => {
        const dialog = activeDialogRef.current;
        if (!dialog) return;
        activeDialogRef.current = null;
        setActiveDialog(null);
        dialog.resolve(result);
        queueMicrotask(showNextDialog);
    }, [showNextDialog]);

    const showAlert = useCallback((options: AlertDialogOptions) => (
        new Promise<void>((resolve) => {
            enqueueDialog({
                kind: 'alert',
                options,
                resolve: () => resolve(),
            });
        })
    ), [enqueueDialog]);

    const showConfirm = useCallback((options: ConfirmDialogOptions) => (
        new Promise<boolean>((resolve) => {
            enqueueDialog({
                kind: 'confirm',
                options,
                resolve: (value) => resolve(value === true),
            });
        })
    ), [enqueueDialog]);

    const showPrompt = useCallback((options: PromptDialogOptions) => (
        new Promise<string | null>((resolve) => {
            enqueueDialog({
                kind: 'prompt',
                options,
                resolve: (value) => resolve(typeof value === 'string' ? value : null),
            });
        })
    ), [enqueueDialog]);

    const cancelActiveDialog = useCallback(() => {
        if (activeDialog?.kind === 'confirm') {
            finishDialog(false);
        } else if (activeDialog?.kind === 'prompt') {
            finishDialog(null);
        } else {
            finishDialog(undefined);
        }
    }, [activeDialog, finishDialog]);

    useEffect(() => () => {
        activeDialogRef.current?.resolve(undefined);
        activeDialogRef.current = null;
        for (const dialog of dialogQueueRef.current) dialog.resolve(undefined);
        dialogQueueRef.current = [];
    }, []);

    useEffect(() => {
        if (!activeDialog) return;

        const previouslyFocused = document.activeElement as HTMLElement | null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const focusFrame = window.requestAnimationFrame(() => {
            if (activeDialog.kind === 'prompt') {
                promptInputRef.current?.focus();
                promptInputRef.current?.select();
            } else {
                primaryActionRef.current?.focus();
            }
        });

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                cancelActiveDialog();
                return;
            }

            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ));
            if (focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            previouslyFocused?.focus();
        };
    }, [activeDialog, cancelActiveDialog]);

    const submitDialog = (event: FormEvent) => {
        event.preventDefault();
        if (!activeDialog) return;
        if (activeDialog.kind === 'prompt') {
            finishDialog(promptValue);
        } else if (activeDialog.kind === 'confirm') {
            finishDialog(true);
        } else {
            finishDialog(undefined);
        }
    };

    const modal = activeDialog && typeof document !== 'undefined'
        ? createPortal(
            <div
                className="app-dialog-backdrop"
                onMouseDown={(event) => {
                    if (event.target === event.currentTarget) cancelActiveDialog();
                }}
            >
                <div
                    ref={dialogRef}
                    className={`app-dialog app-dialog-${activeDialog.options.tone || 'default'}`}
                    role={activeDialog.kind === 'alert' || activeDialog.options.tone === 'danger' ? 'alertdialog' : 'dialog'}
                    aria-modal="true"
                    aria-labelledby={titleId}
                    aria-describedby={messageId}
                >
                    <button
                        type="button"
                        className="app-dialog-close"
                        onClick={cancelActiveDialog}
                        aria-label="Close dialog"
                    >
                        <X size={18} aria-hidden="true" />
                    </button>

                    <div className="app-dialog-heading">
                        <span className="app-dialog-icon" aria-hidden="true">
                            {activeDialog.options.tone === 'danger'
                                ? <AlertTriangle size={21} />
                                : activeDialog.kind === 'prompt'
                                    ? <MessageSquareText size={21} />
                                    : <Info size={21} />}
                        </span>
                        <div>
                            <h2 id={titleId}>{activeDialog.options.title}</h2>
                            <p id={messageId}>{activeDialog.options.message}</p>
                        </div>
                    </div>

                    <form onSubmit={submitDialog} className="app-dialog-form">
                        {activeDialog.kind === 'prompt' && (
                            <label className="app-dialog-field" htmlFor={promptId}>
                                <span>{activeDialog.options.inputLabel}</span>
                                <input
                                    ref={promptInputRef}
                                    id={promptId}
                                    className="input"
                                    value={promptValue}
                                    onChange={(event) => setPromptValue(event.target.value)}
                                    placeholder={activeDialog.options.placeholder}
                                    required={activeDialog.options.required}
                                />
                            </label>
                        )}

                        <div className="app-dialog-actions">
                            {activeDialog.kind !== 'alert' && (
                                <button type="button" className="btn btn-ghost" onClick={cancelActiveDialog}>
                                    {activeDialog.options.cancelLabel || 'Cancel'}
                                </button>
                            )}
                            <button
                                ref={primaryActionRef}
                                type="submit"
                                className={`btn ${activeDialog.options.tone === 'danger' ? 'app-dialog-danger-action' : 'btn-primary'}`}
                                disabled={activeDialog.kind === 'prompt'
                                    && activeDialog.options.required
                                    && !promptValue.trim()}
                            >
                                {activeDialog.kind === 'alert'
                                    ? activeDialog.options.dismissLabel || activeDialog.options.confirmLabel || 'Got it'
                                    : activeDialog.options.confirmLabel || 'Continue'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>,
            document.body,
        )
        : null;

    return (
        <DialogContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
            {children}
            {modal}
        </DialogContext.Provider>
    );
}

export function useAppDialog() {
    const context = useContext(DialogContext);
    if (!context) throw new Error('useAppDialog must be used within a DialogProvider');
    return context;
}
