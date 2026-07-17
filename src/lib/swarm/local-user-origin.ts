type LocalUserOriginCandidate = {
  handle: string;
  nodeId: string | null;
};

/**
 * Federation export routes may only identify accounts created on this node as
 * local. Remote cache rows can have a null nodeId, so both signals are
 * required and any incomplete record fails closed.
 */
export function hasStrictLocalUserOrigin(
  user: LocalUserOriginCandidate,
): boolean {
  return user.nodeId === null && !user.handle.includes('@');
}
