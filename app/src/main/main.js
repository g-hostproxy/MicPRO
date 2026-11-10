const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, nativeImage, protocol, net, shell, session } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ICON = path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// Serve the UI from app://micpro/ so it is a secure context (mic access, AudioWorklet, setSinkId).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
let tray = null;
let quitting = false;
let closeToTray = true;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
}

// Keep audio running at full priority when the window is hidden behind a game.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#14170f',
    title: 'MicPRO',
    icon: ICON,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#14170f', symbolColor: '#b9b4a3', height: 44 },
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.loadURL('app://micpro/index.html');
  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (!quitting && closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 }));
  tray.setToolTip('MicPRO');
  const menu = Menu.buildFromTemplate([
    { label: 'Show MicPRO', click: () => { win.show(); win.focus(); } },
    { label: 'Mute / unmute', click: () => win.webContents.send('hotkey', 'mute') },
    { label: 'Bypass on / off', click: () => win.webContents.send('hotkey', 'bypass') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { win.isVisible() ? win.focus() : win.show(); });
}

function registerHotkeys(map) {
  globalShortcut.unregisterAll();
  const result = {};
  for (const [action, accel] of Object.entries(map || {})) {
    if (!accel) continue;
    try {
      result[action] = globalShortcut.register(accel, () => win && win.webContents.send('hotkey', action));
    } catch {
      result[action] = false;
    }
  }
  return result;
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const ses = session.defaultSession;
  const allowed = new Set(['media', 'speaker-selection', 'audioCapture']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  createWindow();
  createTray();

  app.on('activate', () => { if (win) win.show(); else createWindow(); });
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('hotkeys:set', (_e, map) => registerHotkeys(map));
ipcMain.handle('app:close-to-tray', (_e, v) => { closeToTray = !!v; });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

ipcMain.handle('file:save', async (_e, { data, defaultName, filters }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('music'), defaultName),
    filters: filters || [{ name: 'WAV audio', extensions: ['wav'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, Buffer.from(data));
  return filePath;
});

ipcMain.handle('file:open-json', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { filters: [{ name: 'MicPRO preset', extensions: ['micpro', 'json'] }], properties: ['openFile'] });
  if (canceled || !filePaths[0]) return null;
  return fs.readFile(filePaths[0], 'utf8');
});
