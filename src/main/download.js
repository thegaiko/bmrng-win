'use strict';
// Скачивание .ipa напрямую с CDN Apple и досборка (порт download/repack из
// win_client.py). Сам файл через релей и мак не идёт — только прямая ссылка.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const yauzl = require('yauzl');
const yazl = require('yazl');
const plist = require('plist');
const bplistCreator = require('bplist-creator');
const bplistParser = require('bplist-parser');

const USER_AGENT = 'Configurator/2.17 (Macintosh; OS X 15.2; 24C5089c) AppleWebKit/0620.1.16.11.6';

// --- скачивание с докачкой ------------------------------------------------------

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const start = () => {
      let done = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      const u = new URL(url);
      const headers = { 'User-Agent': USER_AGENT };
      if (done) headers['Range'] = `bytes=${done}-`;
      const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
        if (done && res.statusCode !== 206) { done = 0; }             // сервер не поддержал докачку
        if (res.statusCode >= 400) { res.resume(); return retry(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10) + done;
        const out = fs.createWriteStream(dest, { flags: done ? 'a' : 'w' });
        res.on('data', (chunk) => { done += chunk.length; if (onProgress) onProgress(done, total); });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        res.on('error', retry);
        out.on('error', retry);
      });
      req.on('error', retry);
      req.setTimeout(120000, () => req.destroy(new Error('таймаут скачивания')));
    };
    const retry = (err) => {
      if (++attempt > 5) return reject(new Error('не удалось скачать: ' + err.message));
      setTimeout(start, 3000);
    };
    start();
  });
}

function md5File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// --- досборка .ipa (вкладываем iTunesMetadata.plist и sinf) ---------------------

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => err ? reject(err) : resolve(zip));
  });
}
function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
    });
  });
}

// Собирает список всех записей исходного .ipa.
function listEntries(file) {
  return new Promise((resolve, reject) => {
    const entries = [];
    // autoClose:false — иначе yauzl закроет архив после 'end', а нам ещё читать
    // содержимое записей через openReadStream. Закрываем вручную в repack().
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (e) => { entries.push(e); zip.readEntry(); });
      zip.on('end', () => resolve({ zip, entries }));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function appNameFromEntries(entries) {
  for (const e of entries) {
    const p = e.fileName.split('/');
    if (p.length === 3 && p[0] === 'Payload' && p[1].endsWith('.app') && p[2] === 'Info.plist') return p[1].slice(0, -4);
  }
  for (const e of entries) {
    if (e.fileName.includes('.app/Info.plist') && !e.fileName.includes('/Watch/'))
      return e.fileName.split('.app/Info.plist')[0].split('/').pop();
  }
  throw new Error('в архиве не найден Payload/*.app/Info.plist');
}

function parsePlistMaybeBinary(buf) {
  if (buf.slice(0, 6).toString('latin1') === 'bplist') return bplistParser.parseBuffer(buf)[0];
  return plist.parse(buf.toString('utf8'));
}

// Куда класть sinf: по Manifest.plist, иначе по CFBundleExecutable.
async function sinfTargets(zip, entries, app, sinfs) {
  const byName = Object.fromEntries(entries.map((e) => [e.fileName, e]));
  const manifestPath = `Payload/${app}.app/SC_Info/Manifest.plist`;
  if (byName[manifestPath]) {
    const manifest = parsePlistMaybeBinary(await readEntry(zip, byName[manifestPath]));
    const paths = manifest.SinfPaths || [];
    return paths.map((p, i) => ({ path: `Payload/${app}.app/${p}`, data: sinfs[i].data }));
  }
  const info = parsePlistMaybeBinary(await readEntry(zip, byName[`Payload/${app}.app/Info.plist`]));
  const exe = info.CFBundleExecutable;
  if (!exe) throw new Error('в Info.plist нет CFBundleExecutable');
  return [{ path: `Payload/${app}.app/SC_Info/${exe}.sinf`, data: sinfs[0].data }];
}

// Копирует .ipa, добавляя iTunesMetadata.plist (бинарный) и sinf — как ipatool.
async function repack(src, dest, metadataXmlBase64, sinfs) {
  const metadata = plist.parse(Buffer.from(metadataXmlBase64, 'base64').toString('utf8'));
  const { zip, entries } = await listEntries(src);
  const app = appNameFromEntries(entries);
  const targets = await sinfTargets(zip, entries, app, sinfs);
  const replaced = new Set(['iTunesMetadata.plist', ...targets.map((t) => t.path)]);

  const out = new yazl.ZipFile();
  const stream = out.outputStream.pipe(fs.createWriteStream(dest));

  for (const entry of entries) {
    if (replaced.has(entry.fileName)) continue;
    if (/\/$/.test(entry.fileName)) { out.addEmptyDirectory(entry.fileName); continue; }
    const buf = await readEntry(zip, entry);
    out.addBuffer(buf, entry.fileName);
  }
  out.addBuffer(bplistCreator(metadata), 'iTunesMetadata.plist');
  for (const t of targets) out.addBuffer(Buffer.from(t.data, 'base64'), t.path);
  out.end();

  await new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); });
  zip.close();
  return dest;
}

module.exports = { download, md5File, repack };
