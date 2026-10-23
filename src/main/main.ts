import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { IpcMainInvokeEvent } from 'electron';
import { ReviewStore } from '../core/store';
import { createPipeServer, failure } from './server';
import { pipeName } from '../shared/transport';
import { SettingsStore } from './settings';
import { createTrayIcon } from './tray-icon';
import type { OpenFilesRequest, PrepareSaveRequest, TextEncoding, WireReply } from '../shared/contracts';

const dataDir = process.env.DIFFEDITOR_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'DiffEditor');
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', path.join(dataDir, 'window'));
app.setName('DiffEditor');
// Expose controls and editor focus to Windows screen readers/UI Automation.
app.commandLine.appendSwitch('force-renderer-accessibility');
let win: BrowserWindow | null = null;
let allowClose = false;
let closeRequested = false;
let quitRequested = false;
let tray: Tray | null = null;
let rendererAvailable = true;
let recoveringRenderer = false;
const settings = new SettingsStore(dataDir);
const store = new ReviewStore({ dataDir: path.join(dataDir, 'drafts'), onChange: () => {
  if (win && !win.isDestroyed()) win.webContents.send('review:changed');
} });
const server = createPipeServer(store, restoreWindow);

function restoreWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win!.isMinimized()) win!.restore();
  win!.show(); win!.focus();
}
function finishQuit() {
  allowClose = true;
  app.quit();
}
function requestClose(quit: boolean) {
  quitRequested ||= quit;
  if (!win || win.isDestroyed()) { finishQuit(); return; }
  // Exit must make a failed draft-cache attempt visible and retryable.
  if (quitRequested) restoreWindow();
  if (!rendererAvailable) { void recoverRenderer(); return; }
  closeRequested = true;
  win.webContents.send('review:before-close');
}
async function recoverRenderer() {
  if (recoveringRenderer) return;
  recoveringRenderer = true;
  closeRequested = false;
  quitRequested = false;
  restoreWindow();
  try {
    const result = await dialog.showMessageBox(win!, { type: 'error', title: 'DiffEditor',
      message: '编辑窗口已意外退出', detail: '正式稿不会自动写入。重新打开窗口可恢复最近已缓存的草稿；未缓存的编辑可能无法恢复。',
      buttons: ['恢复窗口', '退出'], defaultId: 0, cancelId: 0 });
    if (result.response === 0 && win && !win.isDestroyed()) await win.loadFile(path.join(__dirname, '../dist/index.html'));
    else finishQuit();
  } finally { recoveringRenderer = false; }
}
function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('DiffEditor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DiffEditor', click: restoreWindow },
    { type: 'separator' },
    { label: '退出', click: () => requestClose(true) },
  ]));
  tray.on('click', restoreWindow);
  tray.on('double-click', restoreWindow);
}

function createWindow() {
  allowClose = false;
  closeRequested = false;
  rendererAvailable = true;
  win = new BrowserWindow({ width: 1440, height: 920, minWidth: 980, minHeight: 640,
    title: 'DiffEditor', backgroundColor: '#f3f5f5', show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && input.key.toLowerCase() === 's' && input.type === 'keyDown') {
      event.preventDefault(); win?.webContents.send('review:save-shortcut');
    }
  });
  win.on('close', event => {
    if (!allowClose) {
      event.preventDefault();
      // Repeated attempts remain possible after a renderer reports a cache error.
      requestClose(quitRequested || !settings.get().closeToTray || !tray || tray.isDestroyed());
    }
  });
  win.on('query-session-end', event => {
    if (allowClose) return;
    event.preventDefault();
    requestClose(true);
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => { rendererAvailable = true; });
  win.webContents.on('render-process-gone', () => {
    if (allowClose) return;
    rendererAvailable = false;
    void recoverRenderer();
  });
  void win.loadFile(path.join(__dirname, '../dist/index.html'));
}
function authorized(event: IpcMainInvokeEvent) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的桌面调用来源');
}
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args): Promise<WireReply> => {
    try { authorized(event); return { ok: true, result: await fn(...args) }; }
    catch (error) { return failure(error); }
  });
}
function handlers() {
  handle('settings:get', () => settings.get());
  handle('settings:set', value => settings.set(value));
  handle('review:list', () => store.list());
  handle('review:open', (request: OpenFilesRequest) => store.openFiles(request));
  handle('review:new-text', () => store.createTextReview());
  handle('review:set-closed', (reviewId, closed) => store.setReviewClosed(reviewId, closed));
  handle('review:delete', reviewId => store.deleteReview(reviewId));
  handle('review:pick', async (mode: 'single' | 'pair', encoding?: TextEncoding) => {
    const choice = await dialog.showOpenDialog(win!, { title: mode === 'pair' ? '选择两个文本文件' : '打开文本文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '论文与文本', extensions: ['tex', 'md', 'bib', 'txt', 'json', 'csv', 'yaml', 'yml', 'toml', 'log', 'py', 'ts', 'js'] }, { name: '所有文件', extensions: ['*'] }] });
    if (choice.canceled) return store.list();
    if (mode === 'pair' && choice.filePaths.length !== 2) throw new Error('双文件比较需要同时选择两个文件。');
    return store.openFiles({ paths: choice.filePaths, mode, encoding });
  });
  handle('review:update', request => store.updateDraft(request));
  handle('review:prepare', async (request: PrepareSaveRequest) => {
    const { reviewId, side, expectedRevision, encoding } = request;
    const saveRequest: PrepareSaveRequest = { reviewId, side, expectedRevision, encoding };
    const review = store.list().reviews.find(item => item.id === request.reviewId);
    if (!review || review.closedAt) throw new Error('请先打开此比较');
    if (request.side !== 'left' && request.side !== 'right') throw new Error('无效的文本侧');
    const target = review.targets.find(item => item.id === review[request.side].targetId);
    if (!target || (review.mode === 'text' && !target.exists && target.status === 'pending')) {
      const choice = await dialog.showSaveDialog(win!, { title: '将文本保存为新文件',
        defaultPath: target?.path || (request.side === 'left' ? '原稿.txt' : '新稿.txt'),
        buttonLabel: '选择保存位置',
        filters: [{ name: '文本文件', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }, { name: 'LaTeX', extensions: ['tex'] }, { name: '所有文件', extensions: ['*'] }] });
      if (choice.canceled || !choice.filePath) return null;
      saveRequest.newPath = choice.filePath;
    }
    return store.prepareSave(saveRequest);
  });
  handle('review:commit', token => store.commitSave(token));
  handle('review:continue', (reviewId, targetId) => store.continueTarget(reviewId, targetId));
  handle('review:reject', reviewId => store.rejectReview(reviewId));
  handle('review:show', (filePath: string) => {
    const allowed = store.list().reviews.some(r => r.targets.some(t => t.path === filePath || t.receipt?.backupPath === filePath));
    if (!allowed) throw new Error('只能定位当前审阅中的文件或备份');
    shell.showItemInFolder(filePath);
  });
  ipcMain.on('review:ready-close', event => {
    if (win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && closeRequested) {
      closeRequested = false;
      if (quitRequested) finishQuit();
      else win.hide();
    }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', restoreWindow);
  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await store.init();
    await settings.init();
    handlers();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeName(), () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', error => dialog.showErrorBox('本地接口异常', error.message));
    createTray();
    createWindow();
  }).catch(error => { dialog.showErrorBox('DiffEditor 无法启动', String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!allowClose && win && !win.isDestroyed()) {
      event.preventDefault();
      requestClose(true);
    }
  });
  app.on('will-quit', () => { server.close(); tray?.destroy(); tray = null; });
}
