/**
 * Atomic HTML file writer for `ExportService`.
 *
 * `write-file-atomic` writes a sibling temporary file and renames it over the
 * target, so a failed export never leaves a truncated document behind. The
 * writer is injectable so unit tests can assert the exact target and payload.
 */

import writeFileAtomic from 'write-file-atomic';

export type HtmlWriter = (targetPath: string, html: string) => Promise<number>;

export const writeHtmlAtomically: HtmlWriter = async (targetPath: string, html: string): Promise<number> => {
  await writeFileAtomic(targetPath, html, { encoding: 'utf8', fsync: true });
  return Buffer.byteLength(html, 'utf8');
};
