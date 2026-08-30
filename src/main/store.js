'use strict';
// Простое файловое хранилище: токен сессии bmrng, device id, конфиг кластера.
// Живёт в userData Electron (%APPDATA%/bmrng на Windows).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    this.tokenFile = path.join(dir, 'backend-session');
    this.metaFile = path.join(dir, 'meta.json');
  }

  _readMeta() {
    try { return JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); } catch { return {}; }
  }
  _writeMeta(meta) {
    try { fs.writeFileSync(this.metaFile, JSON.stringify(meta, null, 2)); } catch {}
  }

  getToken() {
    try {
      const t = fs.readFileSync(this.tokenFile, 'utf8').trim();
      return t || null;
    } catch { return null; }
  }
  setToken(token) {
    try { fs.writeFileSync(this.tokenFile, token, { mode: 0o600 }); } catch {}
  }
  clearToken() {
    try { fs.unlinkSync(this.tokenFile); } catch {}
  }

  get deviceId() {
    const meta = this._readMeta();
    if (meta.device_id) return meta.device_id;
    meta.device_id = crypto.randomUUID();
    this._writeMeta(meta);
    return meta.device_id;
  }
}

module.exports = { Store };
