'use strict';
// Релейный движок bmrng для Windows-клиента (порт win_client.py на Node).
//
// Транспорт: TCP до релея bmrng.app:8712 → рукопожатие с очередью (флаг Q) →
// TLS поверх того же сокета (сквозной до мака, релей видит только шифртекст) →
// сверка SHA-256 отпечатка сертификата мака → HTTP/1.1 keep-alive к маку.
//
// Одно соединение живёт всю сессию: релей выдаёт мак на время соединения, новое
// соединение может попасть на другой мак, где нашей сессии Apple ID нет.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const OK = 0x01;
const BUSY = 0x00;
const WAIT = 0x02;
const QUEUE_RECV_TIMEOUT = 60000;

// --- получение общих настроек с релея (общий токен + список отпечатков) --------

async function fetchClusterConfig(cfg, timeout = 20000) {
  const url = cfg.config_url || (cfg.host ? `https://${String(cfg.host).split(':')[0]}/ipa/config` : null);
  if (!url || !cfg.relay_token) return { ...cfg };
  let data;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.relay_token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return { ...cfg };
    data = await resp.json();
  } catch {
    return { ...cfg };
  }
  if (!data || !data.ok) return { ...cfg };
  const merged = { ...cfg };
  for (const k of ['host', 'port', 'token']) if (data[k]) merged[k] = data[k];
  if (data.fingerprints) merged.fingerprints = data.fingerprints;
  return merged;
}

async function clusterStatus(cfg, timeout = 15000) {
  const url = cfg.config_url || (cfg.host ? `https://${String(cfg.host).split(':')[0]}/ipa/config` : null);
  if (!url || !cfg.relay_token) return { reachable: false, macs: 0 };
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.relay_token}` },
      signal: AbortSignal.timeout(timeout),
    });
    if (!resp.ok) return { reachable: false, macs: 0 };
    const data = await resp.json();
    return { reachable: !!data.ok, macs: (data.fingerprints || []).length };
  } catch {
    return { reachable: false, macs: 0 };
  }
}

function expectedFingerprints(cfg) {
  const out = [];
  for (const src of [cfg.fingerprints, cfg.fingerprint]) {
    if (typeof src === 'string') out.push(src);
    else if (Array.isArray(src)) out.push(...src);
  }
  return [...new Set(out.filter(Boolean))];
}

// --- одно соединение до мака через релей ---------------------------------------

class RelaySession {
  constructor(cfg) {
    this.cfg = cfg;
    this.token = cfg.token || '';
    this.relayToken = cfg.relay_token || null;
    this.expected = expectedFingerprints(cfg);
    this.host = String(cfg.host || '').split(':')[0];
    this.port = cfg.port || 8712;
    this.sock = null;         // TLS-сокет до мака
    this.fingerprint = null;
    this._buf = Buffer.alloc(0);
  }

  // Устанавливает соединение: очередь → TLS → сверка отпечатка.
  // onQueue(position) вызывается, пока мы стоим в очереди.
  connect({ onQueue, timeout = 40000 } = {}) {
    return new Promise((resolve, reject) => {
      const raw = net.connect({ host: this.host, port: this.port });
      let settled = false;
      const fail = (err) => { if (!settled) { settled = true; try { raw.destroy(); } catch {} reject(err); } };

      raw.setTimeout(timeout);
      raw.on('timeout', () => fail(new Error('таймаут подключения к серверу bmrng')));
      raw.on('error', fail);

      raw.once('connect', () => {
        if (!this.relayToken) return this._upgrade(raw, resolve, fail); // прямой режим (LAN)
        raw.write(`IPAR2 CLIENT ${this.relayToken} Q\n`);
        raw.setTimeout(QUEUE_RECV_TIMEOUT);
      });

      // читаем байты рукопожатия очереди
      let acc = Buffer.alloc(0);
      const onData = (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        let i = 0;
        while (i < acc.length) {
          const b = acc[i];
          if (b === OK) {
            acc = acc.slice(i + 1);
            raw.removeListener('data', onData);
            return this._upgrade(raw, resolve, fail, acc);
          }
          if (b === WAIT) {
            if (i + 1 >= acc.length) break;       // ждём байт позиции
            const pos = acc[i + 1];
            i += 2;
            if (onQueue) { try { onQueue(pos); } catch {} }
            continue;
          }
          if (b === BUSY) return fail(new Error('все маки заняты — попробуйте позже'));
          return fail(new Error('сервер отклонил подключение — проверьте конфиг'));
        }
        acc = acc.slice(i);
      };
      if (this.relayToken) raw.on('data', onData);
    });
  }

  _upgrade(raw, resolve, fail, leftover) {
    const tlsSock = tls.connect({
      socket: raw,
      servername: 'ipa-remote',
      rejectUnauthorized: false,
    }, () => {
      const cert = tlsSock.getPeerCertificate(true);
      const der = cert && cert.raw;
      if (!der) return fail(new Error('мак не предъявил сертификат'));
      const fp = crypto.createHash('sha256').update(der).digest('hex');
      if (this.expected.length && !this.expected.includes(fp)) {
        try { tlsSock.destroy(); } catch {}
        return fail(new Error('сертификат мака не совпал с ожидаемым — соединение прервано'));
      }
      this.fingerprint = fp;
      this.sock = tlsSock;
      tlsSock.setTimeout(0);
      resolve(this);
    });
    tlsSock.on('error', fail);
    if (leftover && leftover.length) tlsSock.unshift?.(leftover);
  }

  // Один HTTP-запрос по постоянному соединению. Возвращает распарсенный JSON.
  call(path, payload = null, timeout = 360000) {
    return new Promise((resolve, reject) => {
      const sock = this.sock;
      if (!sock) return reject(new Error('нет соединения с маком'));
      const method = payload != null ? 'POST' : 'GET';
      const body = payload != null ? Buffer.from(JSON.stringify(payload)) : null;
      const headers = [
        `${method} ${path} HTTP/1.1`,
        `Host: ipa-remote`,
        `X-Auth-Token: ${this.token}`,
        `Accept: application/json`,
        `Connection: keep-alive`,
      ];
      if (body) {
        headers.push('Content-Type: application/json');
        headers.push(`Content-Length: ${body.length}`);
      } else {
        headers.push('Content-Length: 0');
      }
      const req = headers.join('\r\n') + '\r\n\r\n';

      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        sock.setTimeout(0);
        sock.removeListener('data', onData);
        sock.removeListener('error', onErr);
        sock.removeListener('close', onClose);
        clearTimeout(timer);
        err ? reject(err) : resolve(val);
      };
      const onErr = (e) => finish(e);
      const onClose = () => finish(new Error('связь с маком оборвалась'));
      const timer = setTimeout(() => finish(new Error('мак не ответил вовремя')), timeout);

      const onData = (chunk) => {
        this._buf = Buffer.concat([this._buf, chunk]);
        const sep = this._buf.indexOf('\r\n\r\n');
        if (sep < 0) return;
        const head = this._buf.slice(0, sep).toString('latin1');
        const lines = head.split('\r\n');
        const status = parseInt(lines[0].split(' ')[1], 10) || 0;
        let length = 0;
        for (const line of lines.slice(1)) {
          const m = /^content-length:\s*(\d+)/i.exec(line);
          if (m) length = parseInt(m[1], 10);
        }
        const bodyStart = sep + 4;
        if (this._buf.length < bodyStart + length) return; // тело ещё не всё
        const respBody = this._buf.slice(bodyStart, bodyStart + length);
        this._buf = this._buf.slice(bodyStart + length);   // остаток — следующему запросу
        let json;
        try { json = JSON.parse(respBody.toString('utf8')); }
        catch { json = { status: 'error', message: `HTTP ${status}` }; }
        finish(null, json);
      };

      sock.setTimeout(timeout, () => finish(new Error('мак не ответил вовремя')));
      sock.on('data', onData);
      sock.once('error', onErr);
      sock.once('close', onClose);
      sock.write(req);
      if (body) sock.write(body);   // тело запроса — иначе мак получит пустой body
    });
  }

  close() {
    if (this.sock) { try { this.sock.destroy(); } catch {} this.sock = null; }
  }
}

module.exports = { RelaySession, fetchClusterConfig, clusterStatus, expectedFingerprints };
