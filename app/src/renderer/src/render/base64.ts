/**
 * Strict base64 helpers.
 *
 * Image payloads arrive from the main process as base64; they are decoded here
 * so the pipeline can verify the declared byte length, sniff the real image
 * format and inspect SVG text without depending on `Buffer` or `atob`.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map<string, number>();
for (let index = 0; index < ALPHABET.length; index += 1) {
  LOOKUP.set(ALPHABET[index] ?? '', index);
}

/** Validates padding and alphabet, then decodes; `null` when malformed. */
export function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;

  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;

  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength <= 0) return null;

  const bytes = new Uint8Array(byteLength);
  let byteIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const a = LOOKUP.get(chunk[0] ?? '');
    const b = LOOKUP.get(chunk[1] ?? '');
    const c = chunk[2] === '=' ? 0 : LOOKUP.get(chunk[2] ?? '');
    const d = chunk[3] === '=' ? 0 : LOOKUP.get(chunk[3] ?? '');
    if (a === undefined || b === undefined || c === undefined || d === undefined) return null;

    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (byteIndex < byteLength) bytes[byteIndex++] = (combined >> 16) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = (combined >> 8) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = combined & 0xff;
  }
  return bytes;
}

/** Decoded length of a well-formed base64 string, or `null`. */
export function base64ByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const length = (value.length / 4) * 3 - padding;
  return length > 0 ? length : null;
}

/** Latin-1 view of raw bytes, used for scanning SVG markup. */
export function bytesToLatin1(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}
