'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AvatarImage } from '@/components/AvatarImage';
import { signedAPI } from '@/lib/api/signed-fetch';
import { useAuth } from '@/lib/contexts/AuthContext';
import { useAppDialog } from '@/lib/contexts/DialogContext';
import { getProfilePath, useFormattedHandle } from '@/lib/utils/handle';
import {
    canonicalAccountAddress,
    displayAccountAddress,
    sameAccountAddress,
} from '@/lib/identity/account-address';

export interface UserListItemUser {
    id: string;
    handle: string;
    displayName?: string | null;
    avatarUrl?: string | null;
    bio?: string | null;
    isNsfw?: boolean;
    nodeIsNsfw?: boolean;
    nodeDomain?: string | null;
    isFollowing?: boolean;
}

interface FollowButtonProps {
    targetHandle: string;
    initialFollowing: boolean;
}

function FollowButton({ targetHandle, initialFollowing }: FollowButtonProps) {
    const {
        user,
        loading: authLoading,
        isIdentityUnlocked,
        isRestoring,
        did,
        handle: currentHandle,
    } = useAuth();
    const { showAlert } = useAppDialog();
    const [isFollowing, setIsFollowing] = useState(initialFollowing);
    const [pending, setPending] = useState(false);

    useEffect(() => {
        setIsFollowing(initialFollowing);
        setPending(false);
    }, [initialFollowing, targetHandle]);

    const canonicalTargetHandle = canonicalAccountAddress(targetHandle);
    const isOwnAccount = Boolean(user && canonicalTargetHandle
        && sameAccountAddress(user.handle, canonicalTargetHandle));

    if (!user || !canonicalTargetHandle || isOwnAccount) return null;

    const handleFollowChange = async () => {
        if (authLoading || isRestoring || pending) return;

        if (!isIdentityUnlocked || !did || !currentHandle) {
            await showAlert({
                title: 'Session expired',
                message: 'Please log in again before changing who you follow.',
            });
            return;
        }

        const wasFollowing = isFollowing;
        setPending(true);

        try {
            const response = wasFollowing
                ? await signedAPI.unfollowUser(canonicalTargetHandle, did, currentHandle)
                : await signedAPI.followUser(canonicalTargetHandle, did, currentHandle);
            const data = await response.json().catch(() => ({})) as {
                error?: string;
                following?: boolean;
            };

            if (!response.ok) {
                throw new Error(data.error || (wasFollowing
                    ? 'Failed to unfollow user'
                    : 'Failed to follow user'));
            }

            setIsFollowing(typeof data.following === 'boolean'
                ? data.following
                : !wasFollowing);
        } catch (error) {
            await showAlert({
                title: wasFollowing ? 'Unfollow failed' : 'Follow failed',
                message: error instanceof Error ? error.message : 'Please try again.',
            });
        } finally {
            setPending(false);
        }
    };

    return (
        <button
            type="button"
            className={`btn btn-sm user-follow-button ${isFollowing ? '' : 'btn-primary'}`}
            onClick={handleFollowChange}
            disabled={authLoading || isRestoring || pending}
            aria-busy={pending}
            aria-pressed={isFollowing}
            aria-label={`${isFollowing ? 'Unfollow' : 'Follow'} ${displayAccountAddress(canonicalTargetHandle)}`}
        >
            {pending
                ? (isFollowing ? 'Unfollowing…' : 'Following…')
                : (isFollowing ? 'Unfollow' : 'Follow')}
        </button>
    );
}

export function UserListItem({ user }: { user: UserListItemUser }) {
    const fullHandle = useFormattedHandle(user.handle, user.nodeDomain);

    return (
        <div className="user-card">
            <Link href={getProfilePath(user.handle)} className="user-card-link">
                <div className="avatar">
                    <AvatarImage
                        avatarUrl={user.avatarUrl}
                        seed={user.handle}
                        nodeDomain={user.nodeDomain}
                        isNsfw={user.isNsfw}
                        nodeIsNsfw={user.nodeIsNsfw}
                        alt={user.displayName || user.handle}
                    />
                </div>
                <div className="user-card-info">
                    <span className="user-card-name">{user.displayName || user.handle}</span>
                    <div className="user-card-handle">{fullHandle}</div>
                    {user.bio && <div className="user-card-bio">{user.bio}</div>}
                </div>
            </Link>
            <FollowButton
                targetHandle={user.handle}
                initialFollowing={user.isFollowing === true}
            />
        </div>
    );
}
