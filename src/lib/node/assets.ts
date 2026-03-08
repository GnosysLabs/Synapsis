export function getNodeAssetVersion(updatedAt: Date | string | null | undefined): string {
  if (!updatedAt) {
    return Date.now().toString();
  }

  const timestamp = new Date(updatedAt).getTime();
  return Number.isNaN(timestamp) ? Date.now().toString() : timestamp.toString();
}

export function getVersionedNodeAssetUrl(path: string, updatedAt: Date | string | null | undefined): string {
  const version = getNodeAssetVersion(updatedAt);
  return `${path}?v=${encodeURIComponent(version)}`;
}
