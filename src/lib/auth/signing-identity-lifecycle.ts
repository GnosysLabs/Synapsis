export function canReuseUnlockedSigningIdentity(input: {
    currentDid?: string | null;
    requestedDid: string;
    hasPrivateKey: boolean;
}): boolean {
    return input.hasPrivateKey && input.currentDid === input.requestedDid;
}
