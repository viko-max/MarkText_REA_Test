/**
 * Test-only PNG writer for wallpaper fixtures.
 *
 * A 1×1 fixture pixel proves nothing visually, so the wallpaper cases generate
 * a real gradient PNG with `node:zlib` only — no new dependency and no binary
 * blob checked into the repository.
 */

import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

export type PixelSource = (x: number, y: number, width: number, height: number) => [number, number, number];

export function encodePng(width: number, height: number, pixel: PixelSource): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y, width, height);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Blue → magenta → warm gradient so a screenshot clearly shows the image. */
export function wallpaperPng(width = 192, height = 120): Buffer {
  return encodePng(width, height, (x, y, w, h) => {
    const u = x / Math.max(1, w - 1);
    const v = y / Math.max(1, h - 1);
    const diagonal = Math.min(1, Math.max(0, (u + v) / 2));
    return [
      Math.round(30 + 200 * diagonal),
      Math.round(90 + 120 * (1 - diagonal)),
      Math.round(200 - 60 * u),
    ];
  });
}
