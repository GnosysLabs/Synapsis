export const STUFFBOX_SCOPES = ['assets:write'] as const;

export type StuffboxScope = (typeof STUFFBOX_SCOPES)[number];

export interface StuffboxTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn?: number;
  scopes: StuffboxScope[];
}

export interface StuffboxUploadSession {
  id: string;
  uploadUrl: string;
  method: 'PUT';
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface StuffboxAsset {
  id: string;
  publicId: string;
  url: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
  status: 'active' | 'deleting' | 'deleted';
  createdAt: string;
  deletedAt?: string;
}
