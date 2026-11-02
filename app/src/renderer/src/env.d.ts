import type { MarkdownLiteApi } from '../../shared/api';

declare global {
  interface Window {
    markdownLite: MarkdownLiteApi;
  }
}

export {};
