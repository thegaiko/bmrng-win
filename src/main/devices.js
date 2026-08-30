'use strict';
// Установка .ipa на подключённый iPhone через libimobiledevice (ideviceinstaller).
// Порт tool()/connected_device()/install_silent() из win_client.py.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Каталог с утилитами: рядом с ресурсами приложения (tools/) или в PATH.
let TOOLS_DIRS = [];
function setToolDirs(dirs) { TOOLS_DIRS = dirs.filter(Boolean); }

function tool(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  for (const dir of TOOLS_DIRS) {
    const p = path.join(dir, exe);
    if (fs.existsSync(p)) return p;
  }
  return exe; // положимся на PATH
}

function run(exe, args, timeout = 180000) {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// UDID первого подключённого устройства (или null).
async function connectedDevice() {
  const exe = tool('idevice_id');
  const first = (out) => (out || '').trim().split(/\s+/).filter(Boolean)[0] || null;
  let r = await run(exe, ['-l'], 15000);
  if (r.err && r.err.code === 'ENOENT') return { error: 'no-tools' };
  let udid = first(r.stdout);
  if (!udid) { r = await run(exe, ['-l'], 8000); udid = first(r.stdout); } // службе Apple нужно мгновение
  return { udid };
}

// Имя устройства (для чека и списания).
async function deviceName(udid) {
  const args = udid ? ['-u', udid, '-k', 'DeviceName'] : ['-k', 'DeviceName'];
  const r = await run(tool('ideviceinfo'), args, 15000);
  const name = (r.stdout || '').trim();
  return name || 'iPhone';
}

// Ставит .ipa; { ok } или { ok:false, error }.
async function install(ipaPath, udid) {
  const exe = tool('ideviceinstaller');
  const dev = udid ? ['-u', udid] : [];
  // старые сборки понимают -i, новые — подкоманду install
  for (const args of [[...dev, '-i', ipaPath], [...dev, 'install', ipaPath]]) {
    const r = await run(exe, args);
    if (r.err && r.err.code === 'ENOENT') return { ok: false, error: 'no-tools' };
    if (r.code === 0) return { ok: true };
  }
  return { ok: false, error: 'install-failed' };
}

function hasTools() {
  return TOOLS_DIRS.some((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'ideviceinstaller.exe' : 'ideviceinstaller')));
}

module.exports = { setToolDirs, connectedDevice, deviceName, install, hasTools };
