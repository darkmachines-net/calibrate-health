/** @file profile Image: Helpers for parsing and serializing small profile images. */

/**
 * Helpers for parsing and serializing small profile images.
 *
 * We store processed (cropped + resized) bytes on the user row so the frontend can render the
 * avatar without introducing a separate asset store for MVP.
 */

export const ALLOWED_PROFILE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// This cap is for the stored *processed* avatar, not the original upload selected by the user.
// Keeping it small avoids bloating auth/user payloads when we inline the image as a data URL.
export const MAX_PROFILE_IMAGE_BYTES = 512 * 1024; // 512 KB

export type ParsedBase64DataUrl = {
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
};

/**
 * Parse a `data:<mimeType>;base64,<payload>` string into raw bytes.
 *
 * Returns null when the string is malformed or contains an unsupported MIME type.
 */
export const parseBase64DataUrl = (dataUrl: string): ParsedBase64DataUrl | null => {
  const trimmed = dataUrl.trim();
  const match = trimmed.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  if (!ALLOWED_PROFILE_IMAGE_MIME_TYPES.has(mimeType)) return null;

  try {
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) return null;
    // Prisma `Bytes` fields are typed as Uint8Array; normalize here for easy reuse.
    const bytes = new Uint8Array(buffer.length);
    bytes.set(buffer);
    return { mimeType, bytes };
  } catch {
    return null;
  }
};

/**
 * Build a base64 data URL suitable for `<img src="...">` / MUI `<Avatar src="...">`.
 */
export const buildBase64DataUrl = (opts: { mimeType: string; bytes: Uint8Array }): string => {
  return `data:${opts.mimeType};base64,${Buffer.from(opts.bytes).toString('base64')}`;
};
