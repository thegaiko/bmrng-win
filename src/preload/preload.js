'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('bmrng', {
  backend: {
    hasToken: () => invoke('backend:hasToken'),
    me: () => invoke('backend:me'),
    login: (email, password) => invoke('backend:login', email, password),
    register: (name, email, password) => invoke('backend:register', name, email, password),
    verify: (email, code) => invoke('backend:verify', email, code),
    resend: (email) => invoke('backend:resend', email),
    resetRequest: (email) => invoke('backend:resetRequest', email),
    resetConfirm: (email, code, password) => invoke('backend:resetConfirm', email, code, password),
    logout: () => invoke('backend:logout'),
    catalog: () => invoke('backend:catalog'),
    topup: (quantity, code) => invoke('backend:topup', quantity, code),
    orderStatus: (id) => invoke('backend:orderStatus', id),
  },
  devices: { check: () => invoke('devices:check') },
  flow: {
    login: (apps, email, password) => invoke('flow:login', apps, email, password),
    code: (code) => invoke('flow:code', code),
    installApp: (meta) => invoke('install:app', meta),
    on: (cb) => ipcRenderer.on('flow', (_e, msg) => cb(msg)),
  },
  update: {
    on: (cb) => ipcRenderer.on('update', (_e, msg) => cb(msg)),
    install: () => invoke('update:install'),
    check: () => invoke('update:check'),
  },
  app: {
    version: () => invoke('app:version'),
    openDownloads: () => invoke('app:openDownloads'),
    openExternal: (url) => invoke('app:openExternal', url),
  },
});
