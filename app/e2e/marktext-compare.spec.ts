/**
 * MarkText v0.23.0 comparison suite.
 *
 * The reference build is launched from `reference/marktext-win-x64-0.23.0`
 * with an isolated `--user-data-dir`. Only channels already confirmed by the
 * static evidence bundle are exercised; anything that cannot be automated is
 * recorded as `unknown` instead of being reported as passing.
 */

import { expect, test } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, executeCase, waitForFileContains, type CaseContext } from './support/harness';
import {
  launchMarktext,
  marktextText,
  observeMarktextExport,
  observeMarktextRender,
  saveMarktextActiveDocument,
  waitForMarktextText,
  MARKTEXT_EXPORT_LIMITATION,
} from './support/marktext';

test.describe.configure({ timeout: 180_000 });

interface CompareRecord {
  id: string;
  status: 'observed' | 'unknown' | 'failed';
  readOnlyLaunch: boolean | null;
  observations: Record<string, unknown>;
  differences: string[];
  unknowns: string[];
  failure: string | null;
}

const records: CompareRecord[] = [];
const startedAt = new Date().toISOString();

function recordFor(id: string): CompareRecord {
  const record: CompareRecord = {
    id,
    status: 'observed',
    readOnlyLaunch: null,
    observations: {},
    differences: [],
    unknowns: [],
    failure: null,
  };
  records.push(record);
  return record;
}

async function runRecordedCase(
  id: string,
  options: Parameters<typeof executeCase>[1],
  body: (context: CaseContext, record: CompareRecord) => Promise<void>,
): Promise<void> {
  const record = recordFor(id);
  try {
    await executeCase(id, options, (context) => body(context, record));
  } catch (error) {
    record.failure = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

test('MarkText comparison: open and render real Markdown', async () => {
  await runRecordedCase(
    'marktext-open-render',
    { seedWorkspaceState: false, enforceConsoleErrors: false },
    async (context, record) => {
      const file = context.workspacePath('首页.md');
      record.readOnlyLaunch = true;
      const page = await launchMarktext(context, { file, readOnly: true });

      await context.step('MarkText opens the fixture note read-only', async () => {
        await waitForMarktextText(page, '首页');
        await waitForMarktextText(page, '功能清单');
        await waitForMarktextText(page, '中文编辑');
        await expect(page.locator('.mu-container h1').first()).toContainText('首页');
      });

      await context.step('MarkText renders the same task, table, code and image content', async () => {
        const observation = await observeMarktextRender(page);
        record.observations.render = observation;
        expect(observation.heading).toContain('首页');
        expect(observation.hasTaskItem).toBe(true);
        expect(observation.tableCount).toBeGreaterThanOrEqual(1);
        expect(observation.codeBlockCount).toBeGreaterThanOrEqual(1);
        expect(observation.imageCount).toBeGreaterThanOrEqual(1);
        expect(observation.loadedImageCount).toBeGreaterThanOrEqual(1);
        expect(observation.hasSeparatePreviewFrame).toBe(false);
        context.note(
          `MarkText WYSIWYG=${String(!observation.hasSeparatePreviewFrame)} images=${observation.imageCount}/${observation.loadedImageCount} title=${String(observation.title)}`,
        );

        record.differences.push(
          'MarkText 在 Muya 所见即所得块树中内联渲染；新应用用独立 iframe 预览，属于主动设计差异',
        );
        record.differences.push(
          `MarkText 图片节点 ${observation.imageCount} 个，其中已加载 ${observation.loadedImageCount} 个；src 方案：${observation.imageSources.join(' | ')}`,
        );
        record.differences.push(
          `MarkText 只读启动时 .mu-editor contenteditable=${String(observation.editorContentEditable)}`,
        );
        record.unknowns.push(
          'MarkText 的只读模式未通过尝试输入验证；已记录编辑器根 contenteditable 状态作为旁证',
        );
      });

      await context.capture('marktext-open');
    },
  );
});

test('MarkText comparison: real save to disk', async () => {
  await runRecordedCase(
    'marktext-save-disk',
    { seedWorkspaceState: false, enforceConsoleErrors: false },
    async (context, record) => {
      const file = context.workspacePath('首页.md');
      record.readOnlyLaunch = false;
      const marker = `MarkText保存标记-${Date.now().toString(36)}`;
      const page = await launchMarktext(context, { file });
      await waitForMarktextText(page, '首页');

      await context.step('typing into the Muya editor appends visible text', async () => {
        const span = page
          .locator('.mu-container span.mu-content', { hasText: '欢迎来到' })
          .first();
        const box = await span.boundingBox();
        if (!box) throw new Error('MarkText paragraph is not laid out');
        await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
        await page.keyboard.insertText(marker);
        await waitForMarktextText(page, marker);
      });

      await context.step('Ctrl+S writes the marker to the real file', async () => {
        await page.keyboard.press('Control+s');
        await page.waitForTimeout(1_500);
        const ctrlSContent = readFileSync(file, 'utf8');
        const ctrlSAloneSaved = ctrlSContent.includes(marker);
        record.observations.ctrlSAloneSavedFile = ctrlSAloneSaved;
        if (!ctrlSAloneSaved) {
          await saveMarktextActiveDocument(page);
        }
        const content = await waitForFileContains(file, marker, 20_000);
        record.observations.savedBytes = Buffer.byteLength(content, 'utf8');
        expect(content).toContain(marker);
        expect(existsSync(file)).toBe(true);
        if (!ctrlSAloneSaved) {
          context.note(
            'CDP 注入的 Ctrl+S 没有触发 Electron 原生菜单加速键；改用渲染端 commandCenter 的 file.save 命令（与 Ctrl+S 绑定的同一命令）完成真实写盘',
          );
        }
      });

      record.observations.editorText = await marktextText(page);
      record.differences.push('两者都会真实写盘；新应用在写盘前额外执行 baseHash CAS，MarkText 不走该检查');
      record.unknowns.push('CDP 注入的 Ctrl+S 不会触发 Electron 原生菜单加速键，改用渲染端 commandCenter 的 file.save 命令（与 Ctrl+S 绑定的同一命令）完成写盘');
      record.unknowns.push('未区分自动保存与手动保存的先后（仅验证文件最终包含标记）');
      await context.capture('marktext-save');
    },
  );
});

test('MarkText comparison: styled HTML export (renderer captured, main write unknown)', async () => {
  await runRecordedCase(
    'marktext-export-html',
    { seedWorkspaceState: false, enforceConsoleErrors: false },
    async (context, record) => {
      const file = context.workspacePath('首页.md');
      record.readOnlyLaunch = false;
      record.status = 'unknown';
      const page = await launchMarktext(context, { file });
      await waitForMarktextText(page, '首页');
      const preview = await observeMarktextRender(page);
      record.observations.previewTheme = {
        bodyBackground: preview.bodyBackground,
        editorContentEditable: preview.editorContentEditable,
      };

      await context.step('the renderer is reachable but no main-process handle exists', async () => {
        expect(context.usesExternalProcess).toBe(true);
        expect(preview.heading).toContain('首页');
        record.unknowns.push(MARKTEXT_EXPORT_LIMITATION);
      });

      await context.step('the real styledHtml renderer payload is captured', async () => {
        const opened = await page.evaluate(() => {
          type Pinia = { _s: Map<string, Record<string, unknown>> };
          const root = document.querySelector('#app') as
            | (HTMLElement & { __vue_app__?: { _context?: { provides?: Record<symbol, unknown> } } })
            | null;
          const provides = root?.__vue_app__?._context?.provides;
          if (!provides) return false;
          const values = Reflect.ownKeys(provides).map((key) => (provides as Record<symbol, unknown>)[key]);
          const pinia = values.find(
            (value): value is Pinia =>
              typeof value === 'object' && value !== null && (value as { _s?: unknown })._s instanceof Map,
          );
          const editor = pinia?._s.get('editor') as
            | { EXPORT?: (payload: unknown) => void }
            | undefined;
          const commandCenter = pinia?._s.get('commandCenter') as
            | {
                rootCommand: {
                  subcommands: Array<{
                    id: string;
                    subcommands?: Array<{ id: string; execute?: () => Promise<void> }>;
                  }>;
                };
              }
            | undefined;
          if (!editor || !commandCenter) return false;

          const scope = window as unknown as {
            __mdlOriginalExport?: (payload: unknown) => void;
            __mdlCapturedExport?: unknown;
            __mdlExportError?: string;
          };
          scope.__mdlOriginalExport = editor.EXPORT;
          editor.EXPORT = (payload: unknown) => {
            scope.__mdlCapturedExport = payload;
          };
          const fileCommand = commandCenter.rootCommand.subcommands.find(
            (entry) => entry.id === 'file.export-file',
          );
          const htmlCommand = fileCommand?.subcommands?.find(
            (entry) => entry.id === 'file.export-file-html',
          );
          if (!htmlCommand?.execute) return false;
          try {
            void htmlCommand.execute();
          } catch (error) {
            scope.__mdlExportError = error instanceof Error ? error.message : String(error);
            return false;
          }
          return true;
        });
        expect(opened).toBe(true);

        const confirm = page.locator('.el-dialog:visible .button-primary').first();
        await confirm.waitFor({ state: 'visible', timeout: 20_000 });
        await confirm.click();
        await page.waitForFunction(
          () => Boolean((window as unknown as { __mdlCapturedExport?: unknown }).__mdlCapturedExport),
          undefined,
          { timeout: 30_000 },
        );

        const payload = await page.evaluate(() => {
          const scope = window as unknown as {
            __mdlCapturedExport?: { type?: unknown; content?: unknown };
            __mdlOriginalExport?: (value: unknown) => void;
          };
          const captured = scope.__mdlCapturedExport;
          const root = document.querySelector('#app') as
            | (HTMLElement & { __vue_app__?: { _context?: { provides?: Record<symbol, unknown> } } })
            | null;
          const provides = root?.__vue_app__?._context?.provides;
          if (provides) {
            const values = Reflect.ownKeys(provides).map((key) => (provides as Record<symbol, unknown>)[key]);
            const pinia = values.find(
              (value): value is { _s: Map<string, Record<string, unknown>> } =>
                typeof value === 'object' &&
                value !== null &&
                (value as { _s?: unknown })._s instanceof Map,
            );
            const editor = pinia?._s.get('editor') as
              | { EXPORT?: (value: unknown) => void }
              | undefined;
            if (editor && scope.__mdlOriginalExport) editor.EXPORT = scope.__mdlOriginalExport;
          }
          return captured
            ? { type: String(captured.type ?? ''), content: String(captured.content ?? '') }
            : null;
        });

        expect(payload).not.toBeNull();
        expect(payload!.type).toBe('styledHtml');
        expect(payload!.content).toContain('<!DOCTYPE html>');
        expect(payload!.content).toContain('首页');

        const artifact = path.join(context.dir, 'marktext-renderer-export.html');
        writeFileSync(artifact, payload!.content);
        context.artifacts['marktext-renderer-export.html'] = artifact;

        const observation = observeMarktextExport(payload!.content);
        record.observations.rendererExport = observation;
        record.observations.rendererExportBytes = Buffer.byteLength(payload!.content, 'utf8');
        expect(observation.hasHeading).toBe(true);
        expect(observation.hasScripts).toBe(false);
        expect(observation.fileUrlImageCount).toBeGreaterThanOrEqual(1);
        expect(observation.dataUriImageCount).toBe(0);
        expect(observation.styleBlockCount).toBeGreaterThanOrEqual(1);
        context.note(
          `renderer export: fileUrlImages=${observation.fileUrlImageCount} dataUriImages=${observation.dataUriImageCount} styleBlocks=${observation.styleBlockCount}`,
        );
      });

      await context.step('the main-process save dialog and file write stay unknown', async () => {
        record.status = 'unknown';
        record.observations.mainFileWrite = null;
        record.observations.staticEvidence =
          'REA 静态证据确认：渲染端内容经 mt::response-export 送入主进程 handleResponseForExport，主进程再调用 dialog.showSaveDialog 并写文件';
        record.differences.push(
          'MarkText 实际渲染的导出内容把本地图片写成 file URL，新应用写成 data URI 单文件',
        );
        record.differences.push(
          `MarkText 导出使用独立的 light 导出主题（${String(
            (record.observations.rendererExport as { styleBlockCount?: number } | undefined)
              ?.styleBlockCount ?? 'unknown',
          )} 个 style 块）；新应用预览与导出共用同一渲染结果`,
        );
        record.unknowns.push(
          '真实文件的落盘与保存对话框未执行：主进程无法在测试进程内替换 dialog.showSaveDialog，因此导出的文件写入路径仍为 unknown',
        );
      });

      await context.capture('marktext-export-renderer');
    },
  );
});

test.afterAll(async () => {
  const target = path.join(APP_ROOT, 'test-results', 'marktext-compare.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    startedAt,
    reference: {
      application: 'MarkText',
      version: 'v0.23.0',
      executable: path.resolve(
        APP_ROOT,
        '..',
        'reference',
        'marktext-win-x64-0.23.0',
        'marktext.exe',
      ),
      launch: 'isolated --user-data-dir per case; --read-only only for the open/render case',
    },
    newApplication: {
      name: 'Markdown Lite Studio',
      version: '0.1.0',
      preview: 'sandboxed iframe[srcDoc]',
      export: 'same RenderResult HTML with embedded data-URI images',
      save: 'baseHash compare-and-swap before atomic write',
    },
    records,
    unknowns: [
      'MarkText 打印/PDF 导出未在本轮自动化范围内',
      'MarkText 主题选择与预览主题的映射没有稳定的可读接口，只记录观察值',
      'MarkText 的只读模式未通过尝试输入验证；只记录了编辑器根 contenteditable 状态',
      'MarkText 通过 CDP 附加后才记录时间，firstWindow 与编辑器可见时间相同，不能与新应用的启动里程碑直接比较',
      'MarkText 主进程 RSS 无法通过 CDP 读取，对照记录为 null',
      'MarkText 的 Ctrl+S 是 Electron 原生菜单加速键，CDP 注入的按键不会触发；真实写盘改用渲染端 commandCenter 的 file.save 命令（同一命令）验证',
    ],
  };
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
});
