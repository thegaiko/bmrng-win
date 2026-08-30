'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { BackendAPI } = require('./backend');
const { InstallFlow } = require('./flow');
const devices = require('./devices');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}

// Реальный cluster-config.json не в git (в нём relay_token) — он подставляется
// при сборке из секрета CI или лежит локально. Без него берём пример-заглушку.
let BOOT;
try { BOOT = require('./cluster-config.json'); }
catch { BOOT = require('./cluster-config.example.json'); }

let win = null;
let store = null;
let backend = null;
let flow = null;
let downloadDir = null;

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: '#F7F5F4',
    title: 'bmrng',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  backend = new BackendAPI(store);
  downloadDir = path.join(app.getPath('userData'), 'Downloads');
  devices.setToolDirs([
    path.join(process.resourcesPath || '', 'tools'),
    path.join(app.getAppPath(), 'resources', 'tools'),
    path.join(app.getAppPath(), '..', 'resources', 'tools'),
  ]);

  createWindow();
  setupUpdater();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- backend / аккаунт ---------------------------------------------------------

function wrap(fn) {
  return async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message, kind: e.kind || 'error' }; }
  };
}

ipcMain.handle('backend:hasToken', wrap(async () => backend.hasToken));
ipcMain.handle('backend:me', wrap(() => backend.me()));
ipcMain.handle('backend:login', wrap((email, password) => backend.login(email, password)));
ipcMain.handle('backend:register', wrap((name, email, password) => backend.register(name, email, password)));
ipcMain.handle('backend:verify', wrap((email, code) => backend.verifyEmail(email, code)));
ipcMain.handle('backend:resend', wrap((email) => backend.resendCode(email)));
ipcMain.handle('backend:resetRequest', wrap((email) => backend.requestPasswordReset(email)));
ipcMain.handle('backend:resetConfirm', wrap((email, code, password) => backend.confirmPasswordReset(email, code, password)));
ipcMain.handle('backend:logout', wrap(async () => { backend.logout(); return true; }));
ipcMain.handle('backend:catalog', wrap(() => backend.catalog()));
ipcMain.handle('backend:topup', wrap((quantity, code) => backend.topUp(quantity, code)));
ipcMain.handle('backend:orderStatus', wrap((id) => backend.orderStatus(id)));

// --- устройство ----------------------------------------------------------------

ipcMain.handle('devices:check', wrap(async () => {
  const d = await devices.connectedDevice();
  if (d.error === 'no-tools') return { tools: false, udid: null };
  const name = d.udid ? await devices.deviceName(d.udid) : null;
  return { tools: devices.hasTools(), udid: d.udid, name };
}));

// --- сценарий установки --------------------------------------------------------

ipcMain.handle('flow:login', wrap(async (apps, email, password) => {
  flow = new InstallFlow({ backend, boot: BOOT, downloadDir, emit: (event, payload) => send('flow', { event, payload }) });
  return flow.login(apps, email, password);
}));
ipcMain.handle('flow:code', wrap(async (code) => {
  if (!flow) throw new Error('сессия не начата');
  return flow.submitCode(code);
}));

// --- прочее --------------------------------------------------------------------

ipcMain.handle('app:openDownloads', wrap(async () => { fs.mkdirSync(downloadDir, { recursive: true }); shell.openPath(downloadDir); return true; }));
ipcMain.handle('app:version', wrap(async () => app.getVersion()));
ipcMain.handle('app:openExternal', wrap(async (url) => { shell.openExternal(url); return true; }));

// --- авто-обновление -----------------------------------------------------------

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', (info) => send('update', { state: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => send('update', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update', { state: 'ready', version: info.version }));
  autoUpdater.on('error', () => {});
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

ipcMain.handle('update:install', wrap(async () => { if (autoUpdater) autoUpdater.quitAndInstall(); return true; }));
