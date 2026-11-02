import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = join(__dirname, '../renderer/index.html');
const rendererFileUrl = pathToFileURL(rendererFile).href;

/** Only the bundled renderer (or the Vite dev server) may be navigated to. */
export function isAllowedNavigation(target: string): boolean {
  if (devServerUrl) {
    try {
      return new URL(target).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return target.split('#')[0] === rendererFileUrl;
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#f6f6f4',
    title: 'Markdown Lite Studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      console.warn('[security] blocked navigation to', url);
    }
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[window] renderer process gone:', details.reason);
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(rendererFile);
  }

  return window;
}
