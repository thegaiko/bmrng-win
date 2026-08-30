'use strict';
// Полный сценарий установки: вход в Apple ID через кластер маков → ссылки →
// освобождение мака → на каждое приложение: скачивание, сборка, списание за
// установку (резерв → установка → подтверждение/возврат).

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { RelaySession, fetchClusterConfig, clusterStatus } = require('./relay');
const dl = require('./download');
const devices = require('./devices');

class InstallFlow {
  // emit(event, payload) — колбэк прогресса в renderer.
  // backend — экземпляр BackendAPI. boot — cluster-config. downloadDir — куда .ipa.
  constructor({ backend, boot, downloadDir, emit }) {
    this.backend = backend;
    this.boot = boot;
    this.downloadDir = downloadDir;
    this.emit = emit;
    this.relay = null;
    this.session = null;
    this.apps = [];
    this.creds = null;
  }

  // Шаг 1: занять мак и войти в Apple ID. Возвращает 'ok' | '2fa' | 'error'.
  async login(apps, email, password) {
    this.apps = apps;
    this.creds = { email, password };
    const status = await clusterStatus(this.boot);
    if (!status.reachable) return { status: 'error', message: 'Нет связи с сервером bmrng. Проверьте интернет.' };
    if (!status.macs) this.emit('phase', { phase: 'no-macs' });

    const cfg = await fetchClusterConfig(this.boot);
    this.relay = new RelaySession(cfg);
    this.emit('phase', { phase: 'connecting' });
    try {
      await this.relay.connect({ onQueue: (pos) => this.emit('phase', { phase: 'queue', position: pos }) });
    } catch (e) {
      return { status: 'error', message: e.message };
    }
    return this._attemptLogin({ email, password });
  }

  // Шаг 2 (если нужно): отправить код 2FA.
  async submitCode(code) {
    return this._attemptLogin({ ...this.creds, auth_code: code });
  }

  async _attemptLogin(body) {
    this.emit('phase', { phase: 'login' });
    let res;
    try { res = await this.relay.call('/login', body, 300000); }
    catch (e) { this._closeRelay(); return { status: 'error', message: e.message }; }

    if (res.status === '2fa_required') return { status: '2fa' };   // мак держим — код придёт на него же
    if (res.status !== 'ok') {
      this._closeRelay();   // вход не удался — отпускаем мак, не держим его зря
      return { status: 'error', message: res.message || 'Не удалось войти в Apple ID' };
    }
    this.session = res.session;
    this.emit('phase', { phase: 'logged-in', name: res.name || this.creds.email });
    this._run().catch((e) => this.emit('done', { error: e.message }));
    return { status: 'ok' };
  }

  _closeRelay() { if (this.relay) { try { this.relay.close(); } catch {} this.relay = null; } }

  // Прервать сессию и освободить мак (при новой попытке или закрытии окна).
  async abort() {
    if (this.relay && this.session) {
      try { await this.relay.call('/logout', { session: this.session }, 30000); } catch {}
    }
    this.session = null;
    this._closeRelay();
  }

  // Шаги 3+: ссылки → освобождение мака → скачивание/сборка/установка каждого.
  async _run() {
    this.emit('phase', { phase: 'links' });
    let links;
    try {
      links = await this.relay.call('/links', {
        app_ids: this.apps.map((a) => a.id), purchase: true, session: this.session,
      }, 600000);
    } catch (e) { this._closeRelay(); return this.emit('done', { error: e.message }); }

    // ссылки на руках — Apple ID и мак больше не нужны
    try { await this.relay.call('/logout', { session: this.session }, 90000); } catch {}
    this._closeRelay();
    this.emit('phase', { phase: 'released' });

    const results = links.results || [];
    const byIndex = new Map(results.map((r, i) => [i, r]));

    // одно устройство на всю партию
    const dev = await devices.connectedDevice();
    const udid = dev.udid || null;
    const deviceNm = udid ? await devices.deviceName(udid) : null;

    let installed = 0;
    for (let i = 0; i < this.apps.length; i++) {
      const app = this.apps[i];
      const info = byIndex.get(i);
      await this._one(app, info, udid, deviceNm).then((ok) => { if (ok) installed++; });
    }

    let balance = null;
    try { balance = (await this.backend.me()).install_balance; } catch {}
    this.emit('done', { installed, total: this.apps.length, balance });
  }

  async _one(app, info, udid, deviceNm) {
    const key = app.key;
    const report = (state, extra = {}) => this.emit('app', { key, state, ...extra });

    if (!info || info.status !== 'ok') {
      report('error', { message: (info && info.message) || 'ссылку получить не удалось' });
      return false;
    }
    report('meta', { name: info.name, version: info.version });

    // 1) скачать напрямую с Apple (бесплатно, деньги — только за установку)
    const tmp = path.join(this.downloadDir, info.file_name + '.part');
    const final = path.join(this.downloadDir, info.file_name);
    try {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      report('downloading', { pct: 0 });
      await dl.download(info.url, tmp, (done, total) => {
        report('downloading', { pct: total ? Math.round((done / total) * 100) : 0 });
      });
      if (info.md5 && (await dl.md5File(tmp)) !== info.md5) { fs.unlinkSync(tmp); throw new Error('md5 не совпал'); }
      report('building');
      try { fs.existsSync(final) && fs.unlinkSync(final); } catch {}
      await dl.repack(tmp, final, info.metadata_plist, info.sinfs);
      try { fs.unlinkSync(tmp); } catch {}
    } catch (e) {
      report('error', { message: 'скачивание/сборка: ' + e.message });
      return false;
    }

    // без телефона — файл готов, деньги не списываем
    if (!udid) { report('ready', { path: final }); return false; }

    // 2) списание: резерв → установка → подтверждение/возврат
    const operationID = crypto.randomUUID();
    try {
      const r = await this.backend.reserveInstall({
        operationID, appKey: key, appName: info.name, appID: String(info.app_id || app.id),
        deviceName: deviceNm, deviceUDID: udid,
      });
      this.emit('balance', { balance: r.balance });
    } catch (e) {
      report('error', { message: 'баланс: ' + e.message, code: 'balance' });
      report('ready', { path: final });   // файл всё равно готов
      return false;
    }

    report('installing');
    const res = await devices.install(final, udid);
    if (res.ok) {
      try { const r = await this.backend.completeInstall(operationID); this.emit('balance', { balance: r.balance }); } catch {}
      report('installed', { path: final });
      return true;
    }
    // не поставилось — возвращаем списанное
    try { const r = await this.backend.refundInstall(operationID); this.emit('balance', { balance: r.balance }); } catch {}
    report('ready', { path: final, message: res.error === 'no-tools' ? 'нет ideviceinstaller' : 'установка не удалась' });
    return false;
  }
}

module.exports = { InstallFlow };
