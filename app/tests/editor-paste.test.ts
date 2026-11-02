import { describe, expect, it } from 'vitest';
import {
  buildImageMarkdown,
  detectPastedImage,
  encodeBase64,
  escapeMarkdownImagePath,
  PASTED_IMAGE_MEDIA_TYPES,
  pastedImageFileName,
  pastedImageMediaType,
  relativeWorkspacePath,
  SVG_PASTE_MESSAGE,
} from '../src/renderer/src/editor/paste';

const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('pasted image detection', () => {
  it('accepts only png, jpeg, gif and webp files', () => {
    expect(PASTED_IMAGE_MEDIA_TYPES).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

    for (const mediaType of PASTED_IMAGE_MEDIA_TYPES) {
      const detection = detectPastedImage([{ type: mediaType, name: `image.${mediaType.slice(6)}` }]);
      expect(detection.kind).toBe('supported');
      if (detection.kind !== 'supported') throw new Error('expected a supported image');
      expect(detection.mediaType).toBe(mediaType);
    }
  });

  it('recognises the format from the file name when the type is missing', () => {
    expect(pastedImageMediaType({ name: '截图.PNG' })).toBe('image/png');
    expect(pastedImageMediaType({ name: 'photo.jpeg' })).toBe('image/jpeg');
    expect(pastedImageMediaType({ name: 'anim.webp' })).toBe('image/webp');
    expect(pastedImageMediaType({ name: 'notes.txt' })).toBeNull();
    expect(pastedImageMediaType({ name: 'noextension' })).toBeNull();
  });

  it('reports SVG explicitly instead of inserting it', () => {
    const detection = detectPastedImage([{ type: 'image/svg+xml', name: 'logo.svg' }]);
    expect(detection).toEqual({ kind: 'svg', message: SVG_PASTE_MESSAGE });
  });

  it('leaves other pastes to CodeMirror', () => {
    expect(detectPastedImage([]).kind).toBe('none');
    expect(detectPastedImage([{ type: 'text/plain', name: 'notes.txt' }]).kind).toBe('none');
    expect(detectPastedImage([{ type: 'image/bmp', name: 'shot.bmp' }]).kind).toBe('none');
  });

  it('prefers a supported image when the clipboard also holds an SVG', () => {
    const detection = detectPastedImage([
      { type: 'image/svg+xml', name: 'logo.svg' },
      { type: 'image/png', name: 'pasted.png' },
    ]);
    expect(detection.kind).toBe('supported');
  });
});

describe('canonical base64', () => {
  it('encodes with the standard alphabet and padding', () => {
    expect(encodeBase64(new Uint8Array([]))).toBe('');
    expect(encodeBase64(new Uint8Array([0x4d]))).toBe('TQ==');
    expect(encodeBase64(new Uint8Array([0x4d, 0x61]))).toBe('TWE=');
    expect(encodeBase64(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu');
    expect(encodeBase64(new Uint8Array([0x00]))).toBe('AA==');
  });

  it('encodes image bytes without data-url prefixes or line breaks', () => {
    const encoded = encodeBase64(pngHeader);
    expect(encoded).toBe('iVBORw0KGgo=');
    expect(encoded).not.toContain('data:');
    expect(encoded).not.toContain('\n');
  });
});

describe('pasted image naming and markdown', () => {
  it('derives a plain file name from the media type and timestamp', () => {
    const now = new Date(2026, 10, 2, 15, 30, 5);
    expect(pastedImageFileName('image/png', now)).toBe('pasted-20261102-153005.png');
    expect(pastedImageFileName('image/jpeg', now)).toBe('pasted-20261102-153005.jpg');
    expect(pastedImageFileName('image/gif', now)).toBe('pasted-20261102-153005.gif');
    expect(pastedImageFileName('image/webp', now)).toBe('pasted-20261102-153005.webp');
  });

  it('escapes spaces, parentheses and percent signs', () => {
    expect(escapeMarkdownImagePath('assets/my image.png')).toBe('assets/my%20image.png');
    expect(escapeMarkdownImagePath('assets/a(b).png')).toBe('assets/a%28b%29.png');
    expect(escapeMarkdownImagePath('assets/50%#1.png')).toBe('assets/50%25%231.png');
    expect(escapeMarkdownImagePath('assets/plain.png')).toBe('assets/plain.png');
  });

  it('computes document-relative asset paths', () => {
    expect(relativeWorkspacePath('a.md', 'assets/x.png')).toBe('assets/x.png');
    expect(relativeWorkspacePath('notes/a.md', 'notes/x.png')).toBe('x.png');
    expect(relativeWorkspacePath('notes/a.md', 'assets/x.png')).toBe('../assets/x.png');
    expect(relativeWorkspacePath('notes/deep/a.md', 'assets/x.png')).toBe('../../assets/x.png');
    expect(relativeWorkspacePath('Notes/a.md', 'notes/x.png')).toBe('x.png');
  });

  it('builds the markdown insertion relative to the document', () => {
    expect(buildImageMarkdown('assets/x.png', 'a.md')).toBe('![](assets/x.png)');
    expect(buildImageMarkdown('assets/x.png', 'notes/a.md')).toBe('![](../assets/x.png)');
    expect(buildImageMarkdown('assets/my image.png', 'notes/a.md')).toBe(
      '![](../assets/my%20image.png)',
    );
  });
});
