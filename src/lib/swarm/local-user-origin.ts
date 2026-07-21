type LocalUserOriginCandidate = {
  isLocalAccount: boolean;
};

/**
 * Local ownership is durable account metadata. It must never be inferred from
 * punctuation, nullable cache fields, or the node currently viewing a record.
 */
export function hasStrictLocalUserOrigin(
  user: LocalUserOriginCandidate,
): boolean {
  return user.isLocalAccount === true;
}
