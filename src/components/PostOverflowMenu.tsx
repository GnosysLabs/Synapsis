import type { CSSProperties, MouseEventHandler } from 'react';
import { FolderPlus, Globe, Trash2, UserX, VolumeX } from 'lucide-react';
import { FlagIcon } from '@/components/Icons';

interface PostOverflowMenuProps {
    onMuteUser: MouseEventHandler<HTMLButtonElement>;
    onBlockUser: MouseEventHandler<HTMLButtonElement>;
    onMuteNode: MouseEventHandler<HTMLButtonElement>;
    onReport: MouseEventHandler<HTMLButtonElement>;
    showMuteNode: boolean;
    reporting: boolean;
    ownerMode?: boolean;
    onAddToCollection?: MouseEventHandler<HTMLButtonElement>;
    onDelete?: MouseEventHandler<HTMLButtonElement>;
    deleting?: boolean;
}

const menuItemStyle: CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    background: 'none',
    border: 'none',
    textAlign: 'left',
    cursor: 'pointer',
    color: 'var(--foreground)',
    fontSize: '14px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
};

export function PostOverflowMenu({
    onMuteUser,
    onBlockUser,
    onMuteNode,
    onReport,
    showMuteNode,
    reporting,
    ownerMode = false,
    onAddToCollection,
    onDelete,
    deleting = false,
}: PostOverflowMenuProps) {
    return (
        <div
            className="post-menu-dropdown"
            role="menu"
            aria-label="Post options"
            style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: '4px',
                background: 'var(--background-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                minWidth: '180px',
                zIndex: 100,
                overflow: 'hidden',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            }}
        >
            {ownerMode ? (
                <>
                    <button type="button" role="menuitem" onClick={onAddToCollection} style={menuItemStyle}>
                        <FolderPlus size={16} />
                        Add to collection
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={onDelete}
                        disabled={deleting}
                        style={{
                            ...menuItemStyle,
                            borderTop: '1px solid var(--border)',
                            color: 'var(--error)',
                            cursor: deleting ? 'default' : 'pointer',
                            opacity: deleting ? 0.65 : 1,
                        }}
                    >
                        <Trash2 size={16} />
                        {deleting ? 'Deleting…' : 'Delete post'}
                    </button>
                </>
            ) : (
                <>
            <button type="button" role="menuitem" onClick={onMuteUser} style={menuItemStyle}>
                <VolumeX size={16} />
                Mute
            </button>
            <button type="button" role="menuitem" onClick={onBlockUser} style={menuItemStyle}>
                <UserX size={16} />
                Block
            </button>
            {showMuteNode && (
                <button
                    type="button"
                    role="menuitem"
                    onClick={onMuteNode}
                    style={{ ...menuItemStyle, borderTop: '1px solid var(--border)' }}
                >
                    <Globe size={16} />
                    Mute node
                </button>
            )}
            <button
                type="button"
                role="menuitem"
                onClick={onReport}
                disabled={reporting}
                style={{
                    ...menuItemStyle,
                    borderTop: '1px solid var(--border)',
                    color: 'var(--error)',
                    cursor: reporting ? 'default' : 'pointer',
                    opacity: reporting ? 0.65 : 1,
                }}
            >
                <FlagIcon />
                {reporting ? 'Reporting…' : 'Report post'}
            </button>
                </>
            )}
        </div>
    );
}
