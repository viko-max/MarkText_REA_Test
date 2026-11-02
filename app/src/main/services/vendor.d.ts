/**
 * Minimal declarations for `write-file-atomic` (the package ships no types).
 * Only the promise API used by the document and state services is described.
 */
declare module 'write-file-atomic' {
  interface WriteFileAtomicOptions {
    encoding?: BufferEncoding | null;
    mode?: number;
    chown?: { uid: number; gid: number };
    fsync?: boolean;
  }

  function writeFileAtomic(
    filename: string,
    data: string | Uint8Array,
    options?: WriteFileAtomicOptions,
  ): Promise<void>;

  export = writeFileAtomic;
}
