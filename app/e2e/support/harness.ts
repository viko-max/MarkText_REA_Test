/**
 * Playwright case harness for the Electron behaviour suite.
 *
 * Every case gets its own throwaway workspace copy under `app/.runtime/e2e`
 * and its own runtime data directory, so no two cases share files, watchers,
 * single-instance locks or persisted UI state. Fixtures are only ever read.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createDefaultWorkspaceUiState } from '../../src/shared/defaults';

export const APP_ROOT = path.resolve(__dirname, '..', '..');
export const REPO_ROOT = path.resolve(APP_ROOT, '..');
export const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixtures', 'notes-demo');
export const RESULTS_ROOT = path.join(APP_ROOT, 'test-results');
export const E2E_ROOT = path.join(APP_ROOT, '.runtime', 'e2e');
export const ELECTRON_EXECUTABLE = path.join(
  APP_ROOT,
  'node_modules',
  'electron',
  'dist',
  'electron.exe',
);

export interface AssertionRecord {
  name: string;
  ok: boolean;
  error?: string;
  detail?: unknown;
}

export interface ErrorRecord {
  source: 'pageerror' | 'console' | 'main';
  message: string;
  stack?: string;
  location?: unknown;
  launch: number;
}

export interface StartupMetrics {
  launch: number;
  firstWindowMs: number;
  shellVisibleMs: number;
}

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface CaseOptions {
  /** Copies `fixtures/notes-demo` into the case workspace (default true). */
  copyFixture?: boolean;
  /** Seeds `runtime/state/workspace-state.json` so `workspace.restore()` opens the copy. */
  seedWorkspaceState?: boolean;
  /** Console errors matching these patterns are expected and do not fail the case. */
  allowedConsoleErrors?: RegExp[];
  /** Main-process error lines matching these patterns are expected. */
  allowedMainErrors?: RegExp[];
  /** Treat renderer console errors as failures (default true; MarkText opts out). */
  enforceConsoleErrors?: boolean;
  /** Extra environment variables passed to the Electron main process. */
  env?: Record<string, string>;
}

export interface CaseReport {
  test: string;
  startedAt: string;
  durationMs: number;
  startup: StartupMetrics[];
  rss: MemorySnapshot | null;
  assertions: AssertionRecord[];
  errors: ErrorRecord[];
  unexpectedErrors: ErrorRecord[];
  notes: string[];
  artifacts: Record<string, string>;
  failure: string | null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError === null ? '' : ` (last error: ${errorMessage(lastError)})`;
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
}

export async function waitForFileContains(
  filePath: string,
  needle: string,
  timeoutMs = 10_000,
): Promise<string> {
  let content = '';
  await waitFor(
    () => {
      if (!existsSync(filePath)) return false;
      content = readFileSync(filePath, 'utf8');
      return content.includes(needle);
    },
    timeoutMs,
    100,
    `${filePath} to contain ${JSON.stringify(needle)}`,
  );
  return content;
}

export async function waitForFile(
  filePath: string,
  timeoutMs = 10_000,
  expectedContent?: string,
): Promise<void> {
  await waitFor(
    () => {
      if (!existsSync(filePath)) return false;
      if (expectedContent === undefined) return true;
      return readFileSync(filePath, 'utf8') === expectedContent;
    },
    timeoutMs,
    100,
    `file ${filePath}`,
  );
}

export class CaseContext {
  readonly name: string;
  readonly dir: string;
  readonly workspaceDir: string;
  readonly runtimeDir: string;
  readonly assertions: AssertionRecord[] = [];
  readonly errors: ErrorRecord[] = [];
  readonly startup: StartupMetrics[] = [];
  readonly notes: string[] = [];
  readonly artifacts: Record<string, string> = {};

  app: ElectronApplication | null = null;
  page: Page | null = null;

  private readonly options: CaseOptions;
  private readonly startedAt = new Date();
  private readonly mainLog: string[] = [];
  private readonly mainErrors: string[] = [];
  private launchIndex = 0;
  private closed = false;
  private external: { child: ChildProcess; browser: Browser } | null = null;

  private constructor(name: string, dir: string, workspaceDir: string, runtimeDir: string, options: CaseOptions) {
    this.name = name;
    this.dir = dir;
    this.workspaceDir = workspaceDir;
    this.runtimeDir = runtimeDir;
    this.options = options;
  }

  static async create(name: string, options: CaseOptions = {}): Promise<CaseContext> {
    const base = path.join(E2E_ROOT, `${name}-${randomUUID().slice(0, 8)}`);
    const dir = path.join(RESULTS_ROOT, name);
    const workspaceDir = path.join(base, 'workspace');
    const runtimeDir = path.join(base, 'runtime');

    rmSync(dir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    if (options.copyFixture !== false) {
      cpSync(FIXTURE_ROOT, workspaceDir, { recursive: true });
    }

    const context = new CaseContext(name, dir, workspaceDir, runtimeDir, options);
    if (options.seedWorkspaceState !== false) {
      context.seedWorkspaceState();
    }
    return context;
  }

  /** Absolute, canonical workspace root (the guard resolves realpath too). */
  get workspaceAbsolute(): string {
    return realpathSync(this.workspaceDir);
  }

  /** The workspace-relative absolute path of a fixture copy. */
  workspacePath(relative: string): string {
    return path.join(this.workspaceAbsolute, ...relative.split('/'));
  }

  seedWorkspaceState(overrides: Partial<ReturnType<typeof createDefaultWorkspaceUiState>> = {}): void {
    const state = { ...createDefaultWorkspaceUiState(this.workspaceAbsolute), ...overrides };
    const stateDir = path.join(this.runtimeDir, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'workspace-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  async launchApp(extraEnv: Record<string, string> = {}): Promise<void> {
    this.launchIndex += 1;
    const launch = this.launchIndex;
    const started = performance.now();

    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const app = await electron.launch({
      executablePath: ELECTRON_EXECUTABLE,
      args: ['.'],
      cwd: APP_ROOT,
      env: {
        ...env,
        MARKDOWN_LITE_USER_DATA: this.runtimeDir,
        TEMP: path.join(this.runtimeDir, 'temp'),
        TMP: path.join(this.runtimeDir, 'temp'),
        ...this.options.env,
        ...extraEnv,
      },
      timeout: 45_000,
    });
    this.app = app;
    this.attachMainLogs(app, launch);

    const page = await app.firstWindow({ timeout: 45_000 });
    const firstWindowMs = performance.now() - started;
    this.attachPage(page, launch);
    await page.waitForSelector('#workspace-shell', { state: 'visible', timeout: 45_000 });
    const shellVisibleMs = performance.now() - started;

    this.page = page;
    this.startup.push({ launch, firstWindowMs, shellVisibleMs });
  }

  /** Closes the current Electron process and launches it again with the same runtime. */
  async relaunchApp(): Promise<void> {
    await this.closeApp();
    this.closed = false;
    await this.launchApp();
  }

  nextLaunchIndex(): number {
    this.launchIndex += 1;
    return this.launchIndex;
  }

  recordStartup(metrics: StartupMetrics): void {
    this.startup.push(metrics);
  }

  /**
   * Adopts a process launched by a caller that needs different executable
   * arguments than the app-under-test (the MarkText comparison suite).
   */
  async adoptElectron(app: ElectronApplication, launch: number): Promise<Page> {
    this.app = app;
    this.attachMainLogs(app, launch);
    const page = await app.firstWindow({ timeout: 60_000 });
    this.attachPage(page, launch);
    this.page = page;
    return page;
  }

  /**
   * Adopts a process controlled through the Chromium DevTools protocol.
   *
   * MarkText 0.23.0 has the `EnableNodeCliInspectArguments` fuse disabled, so
   * Playwright's `_electron.launch()` cannot obtain a main-process handle. The
   * renderer is still reachable through `--remote-debugging-port`, which is what
   * this method records.
   */
  adoptExternal(child: ChildProcess, browser: Browser, page: Page, launch: number): void {
    this.external = { child, browser };
    this.attachChildLogs(child, launch);
    this.attachPage(page, launch);
    this.page = page;
  }

  /** True when the case drives a process through CDP instead of Playwright's Electron API. */
  get usesExternalProcess(): boolean {
    return this.external !== null;
  }

  async step<T>(name: string, body: () => Promise<T>): Promise<T> {
    try {
      const value = await body();
      this.assertions.push({ name, ok: true });
      return value;
    } catch (error) {
      this.assertions.push({ name, ok: false, error: errorMessage(error) });
      throw error;
    }
  }

  note(message: string): void {
    this.notes.push(message);
  }

  async capture(label: string): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    const file = path.join(this.dir, `screenshot-${label}.png`);
    try {
      await this.page.screenshot({ path: file });
      this.artifacts[`screenshot-${label}`] = file;
    } catch {
      // A capture failure must not hide the actual assertion result.
    }
  }

  private async captureFinal(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    const file = path.join(this.dir, 'screenshot.png');
    try {
      await this.page.screenshot({ path: file });
      this.artifacts.screenshot = file;
    } catch {
      // Keep the report even if the window disappeared before the capture.
    }
  }

  async mainRss(): Promise<MemorySnapshot | null> {
    if (!this.app) return null;
    try {
      const usage = await this.app.evaluate(() => process.memoryUsage());
      return {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
      };
    } catch {
      return null;
    }
  }

  /** Replaces the native save dialog in the test process only. */
  async stubSaveDialog(filePath: string): Promise<void> {
    if (!this.app) throw new Error('application is not running');
    await this.app.evaluate((electronModule, target) => {
      const dialog = electronModule.dialog as unknown as {
        showSaveDialog: (options: unknown) => Promise<unknown>;
      };
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: target,
        bookmark: '',
      });
    }, filePath);
  }

  /** Replaces the native open dialog in the test process only. */
  async stubOpenDialog(filePath: string): Promise<void> {
    if (!this.app) throw new Error('application is not running');
    await this.app.evaluate((electronModule, target) => {
      const dialog = electronModule.dialog as unknown as {
        showOpenDialog: (...args: unknown[]) => Promise<unknown>;
      };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [target],
        bookmarks: [],
      });
    }, filePath);
  }

  unexpectedErrors(): ErrorRecord[] {
    if (this.options.enforceConsoleErrors === false) return [];
    const allowedConsole = this.options.allowedConsoleErrors ?? [];
    const allowedMain = this.options.allowedMainErrors ?? [];
    return this.errors.filter((entry) => {
      if (entry.source === 'pageerror') return true;
      if (entry.source === 'main') return !allowedMain.some((pattern) => pattern.test(entry.message));
      return !allowedConsole.some((pattern) => pattern.test(entry.message));
    });
  }

  async finish(failure: unknown): Promise<CaseReport> {
    if (!this.closed) {
      await this.captureFinal();
      const rss = await this.mainRss();
      const unexpected = this.unexpectedErrors();

      writeFileSync(path.join(this.dir, 'main.log'), `${this.mainLog.join('')}\n`);
      this.artifacts['result.json'] = path.join(this.dir, 'result.json');
      this.artifacts['main.log'] = path.join(this.dir, 'main.log');

      const report: CaseReport = {
        test: this.name,
        startedAt: this.startedAt.toISOString(),
        durationMs: Date.now() - this.startedAt.getTime(),
        startup: this.startup,
        rss,
        assertions: this.assertions,
        errors: this.errors,
        unexpectedErrors: unexpected,
        notes: this.notes,
        artifacts: this.artifacts,
        failure: failure === null || failure === undefined ? null : errorMessage(failure),
      };

      writeFileSync(path.join(this.dir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);

      await this.closeApp();
      this.closed = true;

      if (failure === null || failure === undefined) {
        if (unexpected.length > 0) {
          const detail = unexpected
            .map((entry) => `[${entry.source}] ${entry.message}`)
            .join('\n');
          throw new Error(`unexpected renderer/main errors:\n${detail}`);
        }
      }
      return report;
    }

    return {
      test: this.name,
      startedAt: this.startedAt.toISOString(),
      durationMs: Date.now() - this.startedAt.getTime(),
      startup: this.startup,
      rss: null,
      assertions: this.assertions,
      errors: this.errors,
      unexpectedErrors: [],
      notes: this.notes,
      artifacts: this.artifacts,
      failure: failure === null || failure === undefined ? null : errorMessage(failure),
    };
  }

  async closeApp(): Promise<void> {
    const external = this.external;
    this.external = null;
    if (external) {
      this.page = null;
      try {
        await Promise.race([external.browser.close(), delay(5_000)]);
      } catch {
        // Disconnecting is best effort; the process is terminated next.
      }
      await terminateProcessTree(external.child);
      return;
    }

    const app = this.app;
    this.app = null;
    this.page = null;
    if (!app) return;
    try {
      await Promise.race([app.close(), delay(20_000)]);
    } catch {
      // The process may already have exited; the next launch verifies the lock.
    }
  }

  private attachPage(page: Page, launch: number): void {
    page.on('pageerror', (error) => {
      this.errors.push({
        source: 'pageerror',
        message: error.message,
        stack: error.stack,
        launch,
      });
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      this.errors.push({
        source: 'console',
        message: message.text(),
        location: message.location(),
        launch,
      });
    });
  }

  private attachMainLogs(app: ElectronApplication, launch: number): void {
    this.attachChildLogs(app.process(), launch);
  }

  private attachChildLogs(child: ChildProcess, launch: number): void {
    const record = (chunk: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      const text = chunk.toString();
      this.mainLog.push(`[${launch}:${stream}] ${text}`);
      if (stream === 'stderr' && text.includes('uncaught exception')) {
        this.mainErrors.push(text);
        this.errors.push({ source: 'main', message: text.trim(), launch });
      }
      if (text.includes('[ipc] unhandled handler error')) {
        this.mainErrors.push(text);
        this.errors.push({ source: 'main', message: text.trim(), launch });
      }
    };
    child.stdout?.on('data', (chunk) => record(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => record(chunk, 'stderr'));
  }
}

/** Best-effort termination of a test-owned process and its children. */
async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  try {
    child.kill();
  } catch {
    // Fall through to taskkill.
  }
  const quick = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4_000)),
  ]);
  if (quick) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
  }
  await Promise.race([exited, delay(4_000)]);
}

/** Runs a case body and always persists the report; rethrows the body failure. */
export async function executeCase(
  name: string,
  options: CaseOptions,
  body: (context: CaseContext) => Promise<void>,
): Promise<void> {
  const context = await CaseContext.create(name, options);
  let failure: unknown = null;
  let finishError: unknown = null;
  try {
    await body(context);
  } catch (error) {
    failure = error;
  }
  try {
    await context.finish(failure);
  } catch (error) {
    finishError = error;
  }
  if (failure !== null) throw failure;
  if (finishError !== null) throw finishError;
}
