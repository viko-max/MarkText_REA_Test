import type { BrowserWindow } from 'electron';
import { app, session } from 'electron';
import { registerIpcHandlers } from './ipc';
import { configureRuntimePaths } from './runtime-paths';
import { createServices } from './services';
import { createMainWindow } from './window';

app.enableSandbox();

const runtime = configureRuntimePaths();

let mainWindow: BrowserWindow | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function openMainWindow(): BrowserWindow {
  const window = createMainWindow();
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function hardenSession(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.on('will-download', (event) => {
    event.preventDefault();
    console.warn('[security] blocked download request');
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app
    .whenReady()
    .then(() => {
      hardenSession();
      registerIpcHandlers(createServices(getWindow), getWindow, runtime);
      mainWindow = openMainWindow();

      app.on('activate', () => {
        if (!getWindow()) mainWindow = openMainWindow();
      });
    })
    .catch((error: unknown) => {
      console.error('[main] failed to start', error);
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
