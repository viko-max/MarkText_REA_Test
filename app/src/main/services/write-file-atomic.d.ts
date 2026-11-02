/**
 * Minimal local declaration for `write-file-atomic` 8.x, which ships no types.
 * Only the options `export-writer.ts` uses are declared.
 */
declare module 'write-file-atomic' {
  interface WriteFileAtomicOptions {
    encoding?: BufferEncoding;
    mode?: number;
    fsync?: boolean;
    chown?: { uid: number; gid: number };
    tmpfileCreated?: (tmpfile: string) => void;
  }

  function writeFileAtomic(
    fileName: string,
    data: string | Uint8Array,
    options?: WriteFileAtomicOptions,
  ): Promise<void>;

  export = writeFileAtomic;
}
