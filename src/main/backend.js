'use strict';
// Клиент бэкенда bmrng (тот же, что у Mac-приложения): аккаунты, баланс,
// списание по установке. База — https://bmrng.app/api/, токен-авторизация.

const BASE = 'https://bmrng.app/api/';

class BackendError extends Error {
  constructor(message, kind = 'server') { super(message); this.kind = kind; }
}

class BackendAPI {
  constructor(store) {
    this.store = store;
    this.token = store ? store.getToken() : null;
  }

  get hasToken() { return !!this.token; }

  async _request(path, { method = 'GET', body = null, authorized = true } = {}) {
    const headers = { Accept: 'application/json', 'X-Platform': 'win' };
    if (body) headers['Content-Type'] = 'application/json';
    if (authorized) {
      if (!this.token) throw new BackendError('Сессия bmrng истекла. Войдите снова.', 'unauthorized');
      headers['Authorization'] = `Token ${this.token}`;
    }
    let resp;
    try {
      resp = await fetch(BASE + path, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new BackendError('Нет связи с сервером bmrng. Проверьте интернет.', 'network');
    }
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!resp.ok) {
      if (resp.status === 401) throw new BackendError('Сессия bmrng истекла. Войдите снова.', 'unauthorized');
      throw new BackendError(errorMessage(data) || `Ошибка сервера bmrng (${resp.status}).`);
    }
    return data;
  }

  _saveToken(token) { this.token = token; if (this.store) this.store.setToken(token); }

  async login(email, password) {
    const r = await this._request('login/', { method: 'POST', authorized: false, body: { email, password } });
    this._saveToken(r.token);
    return r.user;
  }
  async register(name, email, password) {
    return this._request('register/', {
      method: 'POST', authorized: false,
      body: { name, email, password, platform: 'win', device_id: this.store.deviceId },
    });
  }
  async verifyEmail(email, code) {
    const r = await this._request('verify-email/', { method: 'POST', authorized: false, body: { email, code } });
    this._saveToken(r.token);
    return r.user;
  }
  resendCode(email) {
    return this._request('resend-code/', { method: 'POST', authorized: false, body: { email } });
  }
  requestPasswordReset(email) {
    return this._request('password-reset/request/', { method: 'POST', authorized: false, body: { email } });
  }
  confirmPasswordReset(email, code, password) {
    return this._request('password-reset/confirm/', { method: 'POST', authorized: false, body: { email, code, password } });
  }
  logout() { this.token = null; if (this.store) this.store.clearToken(); }

  me() { return this._request('me/'); }
  catalog() { return this._request('catalog/', { authorized: false }); }
  topUp(quantity, code) { return this._request('topup/', { method: 'POST', body: { quantity, code } }); }
  orderStatus(orderID) { return this._request(`order/${orderID}/status/`, { authorized: false }); }

  // Списание за установку: резерв → подтверждение / возврат.
  reserveInstall({ operationID, appKey, appName, appID, deviceName, deviceUDID }) {
    return this._request('consume/', {
      method: 'POST',
      body: {
        operation_id: operationID, app_key: appKey, app_name: appName, app_id: appID,
        device_name: deviceName, device_udid: deviceUDID, platform: 'win',
      },
    });
  }
  completeInstall(operationID) {
    return this._request('consume/complete/', { method: 'POST', body: { operation_id: operationID } });
  }
  refundInstall(operationID) {
    return this._request('consume/refund/', { method: 'POST', body: { operation_id: operationID } });
  }
}

function errorMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.detail === 'string') return data.detail;
  const parts = [];
  for (const v of Object.values(data)) {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(v.join(' '));
  }
  return parts.join(' ') || null;
}

module.exports = { BackendAPI, BackendError };
