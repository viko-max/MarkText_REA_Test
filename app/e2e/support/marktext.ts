/**
 * MarkText v0.23.0 launcher and observation helpers for the comparison suite.
 *
 * MarkText 0.23.0 ships with the Electron `EnableNodeCliInspectArguments` fuse
 * disabled, so Playwright's `_electron.launch()` cannot attach a main-process
 * handle (no `Debugger listening` line is ever printed). Its renderer is still
 * reachable through Chromium's `--remote-debugging-port`, which is the channel
 * used here. The application is launched with an isolated `--user-data-dir`;
 * its default profile is never touched.
 */

import { chromium, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, type CaseContext } from './harness';

export const MARKTEXT_DIR = path.join(REPO_ROOT, 'reference', 'marktext-win-x64-0.23.0');
export const MARKTEXT_EXE = path.join(MARKTEXT_DIR, 'marktext.exe');
const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/\S+)/;

export interface MarktextLaunchOptions {
  /** Absolute path of the Markdown document to open. */
  file: string;
  readOnly?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launches MarkText with an isolated profile, connects to its renderer over
 * CDP and waits for the Muya editor.
 */
export async function launchMarktext(
  context: CaseContext,
  options: MarktextLaunchOptions,
): Promise<Page> {
  const launch = context.nextLaunchIndex();
  const started = performance.now();
  const envRoot = path.join(context.runtimeDir, 'env');
  const home = path.join(envRoot, 'home');
  const appData = path.join(envRoot, 'appdata');
  const localAppData = path.join(envRoot, 'localappdata');
  const temp = path.join(envRoot, 'temp');
  for (const directory of [home, appData, localAppData, temp]) mkdirSync(directory, { recursive: true });

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const args = [
    '--user-data-dir',
    path.join(context.runtimeDir, 'marktext-user-data'),
    '--remote-debugging-port=0',
    '--disable-gpu',
    '--disable-spellcheck',
    ...(options.readOnly ? ['--read-only'] : []),
    options.file,
  ];

  const child: ChildProcess = spawn(MARKTEXT_EXE, args, {
    cwd: MARKTEXT_DIR,
    env: {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: temp,
      TMP: temp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const endpoint = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`MarkText did not expose a DevTools endpoint.\n${stderr.slice(-2000)}`));
    }, 60_000);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stderr?.on('data', () => {
      const match = DEVTOOLS_LINE.exec(stderr);
      if (match?.[1]) finish(() => resolve(match[1]!));
    });
    child.once('exit', (code) => {
      finish(() => reject(new Error(`MarkText exited early with code ${String(code)}\n${stderr.slice(-2000)}`)));
    });
  });

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 });

  let page: Page | null = null;
  const deadline = Date.now() + 45_000;
  while (page === null && Date.now() < deadline) {
    for (const browserContext of browser.contexts()) {
      for (const candidate of browserContext.pages()) {
        if (candidate.isClosed()) continue;
        try {
          if ((await candidate.locator('.mu-container').count()) > 0) {
            page = candidate;
            break;
          }
        } catch {
          // The target can disappear while MarkText creates its first window.
        }
      }
      if (page !== null) break;
    }
    if (page === null) await delay(250);
  }
  if (page === null) {
    throw new Error('MarkText renderer page with .mu-container was not found');
  }

  await page.waitForSelector('.mu-container', { state: 'visible', timeout: 60_000 });
  context.adoptExternal(child, browser, page, launch);
  context.recordStartup({
    launch,
    firstWindowMs: performance.now() - started,
    shellVisibleMs: performance.now() - started,
  });
  return page;
}

export async function marktextText(page: Page): Promise<string> {
  return page.locator('.mu-container').innerText();
}

/**
 * Runs the renderer command bound to the `Ctrl+S` menu accelerator.
 *
 * Playwright's CDP keyboard events reach the renderer but not Electron's native
 * menu, so the accelerator itself cannot be delivered. Executing `file.save`
 * through the renderer command center (falling back to the editor store action)
 * keeps the real save path: flush editor → `mt::response-file-save` → main write.
 */
export async function saveMarktextActiveDocument(page: Page): Promise<void> {
  const message = await page.evaluate(async () => {
    type Pinia = { _s: Map<string, Record<string, unknown>> };
    const root = document.querySelector('#app') as
      | (HTMLElement & { __vue_app__?: { _context?: { provides?: Record<symbol, unknown> } } })
      | null;
    const provides = root?.__vue_app__?._context?.provides;
    if (!provides) return 'Vue app provides are unavailable';
    const values = Reflect.ownKeys(provides).map((key) => (provides as Record<symbol, unknown>)[key]);
    const pinia = values.find(
      (value): value is Pinia =>
        typeof value === 'object' && value !== null && (value as { _s?: unknown })._s instanceof Map,
    );
    if (!pinia) return 'Pinia store is unavailable';
    const editor = pinia._s.get('editor') as { FILE_SAVE?: () => void } | undefined;
    const commandCenter = pinia._s.get('commandCenter') as
      | { rootCommand?: { subcommands?: Array<{ id: string; execute?: () => Promise<void> | void }> } }
      | undefined;
    const saveCommand = commandCenter?.rootCommand?.subcommands?.find((entry) => entry.id === 'file.save');
    if (saveCommand?.execute) {
      await saveCommand.execute();
      return 'ok';
    }
    if (typeof editor?.FILE_SAVE === 'function') {
      editor.FILE_SAVE();
      return 'ok';
    }
    return 'editor save command is unavailable';
  });
  if (message !== 'ok') throw new Error(`MarkText save action failed: ${message}`);
}

export async function waitForMarktextText(
  page: Page,
  text: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await marktextText(page)).includes(text)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`MarkText editor did not show ${JSON.stringify(text)} within ${timeoutMs}ms`);
}

export interface MarktextRenderObservation {
  title: string;
  heading: string | null;
  hasTaskItem: boolean;
  tableCount: number;
  codeBlockCount: number;
  imageCount: number;
  imageSources: string[];
  loadedImageCount: number;
  editorContentEditable: string | null;
  hasSeparatePreviewFrame: boolean;
  bodyBackground: string;
}

/** Reads the WYSIWYG editor DOM without touching MarkText internals. */
export async function observeMarktextRender(page: Page): Promise<MarktextRenderObservation> {
  return page.evaluate(() => {
    const container = document.querySelector('.mu-container') as HTMLElement | null;
    const editorRoot = document.querySelector('.mu-editor') as HTMLElement | null;
    const images = [...document.querySelectorAll<HTMLImageElement>('.mu-container img')];
    return {
      title: document.title,
      heading: document.querySelector('.mu-container h1')?.textContent ?? null,
      hasTaskItem: document.querySelectorAll('.mu-container li.mu-task-list-item').length > 0,
      tableCount: document.querySelectorAll('.mu-container table').length,
      codeBlockCount: document.querySelectorAll('.mu-container pre').length,
      imageCount: images.length,
      imageSources: images.map((image) => {
        const source = image.getAttribute('src') ?? '';
        if (source.startsWith('data:')) {
          const media = source.slice(0, source.indexOf(';') > 0 ? source.indexOf(';') : 32);
          return `${media};base64,…(${source.length} chars)`;
        }
        return source;
      }),
      loadedImageCount: images.filter((image) => image.complete && image.naturalWidth > 0).length,
      editorContentEditable:
        editorRoot?.getAttribute('contenteditable') ?? container?.getAttribute('contenteditable') ?? null,
      hasSeparatePreviewFrame: document.querySelectorAll('iframe').length > 0,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  });
}

export interface MarktextExportObservation {
  title: string | null;
  hasHeading: boolean;
  imageSources: string[];
  fileUrlImageCount: number;
  dataUriImageCount: number;
  styleBlockCount: number;
  generator: string | null;
  hasScripts: boolean;
  cssSample: string;
}

/** Static inspection of an exported HTML file text (no rendering). */
export function observeMarktextExport(html: string): MarktextExportObservation {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const sources = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((match) => {
    const source = match[1] ?? '';
    if (!source.startsWith('data:')) return source;
    const media = source.slice(0, source.indexOf(';') > 0 ? source.indexOf(';') : 32);
    return `${media};base64,…(${source.length} chars)`;
  });
  return {
    title: titleMatch ? titleMatch[1]!.trim() : null,
    hasHeading: /<h1[\s>]/i.test(html),
    imageSources: sources,
    fileUrlImageCount: sources.filter((source) => /^file:\/\//i.test(source)).length,
    dataUriImageCount: sources.filter((source) => /^data:image\//i.test(source)).length,
    styleBlockCount: (html.match(/<style[\s>]/gi) ?? []).length,
    generator: /<meta[^>]+name="generator"[^>]+content="([^"]+)"/i.exec(html)?.[1] ?? null,
    hasScripts: /<script[\s>]/i.test(html),
    cssSample: /<style[^>]*>([\s\S]{0,400})/i.exec(html)?.[1] ?? '',
  };
}

/**
 * The styledHtml *file write* cannot be driven from this harness: the save
 * destination is chosen inside the main process by `dialog.showSaveDialog`, and
 * MarkText's disabled Node-inspect fuse prevents any main-process test handle.
 * The renderer payload itself is still captured by invoking the renderer's own
 * command center; only the main-process write stays unknown.
 */
export const MARKTEXT_EXPORT_LIMITATION =
  'MarkText 0.23.0 的 EnableNodeCliInspectArguments fuse 为 disabled，Playwright 无法取得主进程句柄；styledHtml 的真实文件写入与 dialog.showSaveDialog 目标替换无法自动化（渲染端生成的 HTML payload 已单独捕获）';

