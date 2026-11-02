/**
 * Heading anchors shared by the preview and the exported document.
 *
 * Ids are derived from the human readable heading text (CJK included), made
 * unique per document, and reused for the generated outline.
 */

export interface HeadingSlugger {
  slug(text: string): string;
}

const ALLOWED_CHARACTERS = /[^\p{L}\p{N}\s_-]/gu;
const WHITESPACE = /[\s_-]+/g;

export function slugifyHeadingText(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(ALLOWED_CHARACTERS, '')
    .replace(WHITESPACE, '-')
    .replace(/^-+|-+$/g, '');
  const limited = normalized.slice(0, 80).replace(/-+$/g, '');
  return limited.length > 0 ? limited : 'section';
}

export function createHeadingSlugger(): HeadingSlugger {
  const seen = new Map<string, number>();
  return {
    slug(text: string): string {
      const base = slugifyHeadingText(text);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base}-${count}`;
    },
  };
}
