# bmrng для Windows

Нативное приложение (Electron) для установки приложений из App Store на iPhone —
Windows-аналог Mac-клиента bmrng. Скачивается как `.exe`-установщик: поставил,
запустил, вошёл в аккаунт bmrng, выбрал приложения, ввёл Apple ID — приложение
качается напрямую с Apple и ставится на подключённый iPhone. За каждую установку
списывается с баланса аккаунта.

## Что переиспользуется

- **Аккаунты и баланс** — существующий бэкенд `https://bmrng.app/api/` (тот же, что
  у Mac-приложения): вход/регистрация/подтверждение почты/сброс пароля, баланс
  `install_balance`, цена `price_per_install`, списание по установке через
  `consume/` → `consume/complete/` → `consume/refund/` (резерв → подтверждение →
  возврат). См. `src/main/backend.js`.
- **Движок скачивания** — релейный кластер маков (`bmrng.app:8712`): вход в Apple ID,
  очередь при занятых маках, прямые ссылки Apple CDN, сборка `.ipa` с `sinf` и
  `iTunesMetadata`. Порт `win_client.py` на Node — `src/main/relay.js`,
  `download.js`, `flow.js`.
- **Бренд** — лого, шрифт Geologica-Black, палитра `#005AFF` из Mac-приложения
  (`src/renderer/`).
- **Авто-обновление** — `electron-updater` + GitHub Releases (по образцу манифеста
  `bmrng-new-version.json`).

## Разработка

Нужен Node 20+. На Windows:

```bash
npm install
npm start          # запустит приложение в дев-режиме
```

## Сборка .exe

### Через GitHub Actions (рекомендуется)

1. Создайте GitHub-репозиторий и запушьте туда содержимое этой папки.
2. В `package.json` замените `repository.url` на адрес вашего репозитория
   (owner/repo electron-builder возьмёт оттуда автоматически).
3. Выпуск версии:
   ```bash
   npm version patch          # поднимет version в package.json и создаст git-тег
   git push --follow-tags
   ```
   Тег `vX.Y.Z` запускает workflow `.github/workflows/release.yml`: он собирает
   `.exe` на Windows-раннере, кладёт libimobiledevice внутрь и публикует установщик
   в **GitHub Releases**. Приложение обновляется оттуда само.

Секрет `GITHUB_TOKEN` даётся Actions автоматически — ничего добавлять не нужно.
Релиз должен быть публичным (или настройте приватный feed), чтобы авто-обновление
работало у пользователей.

### Локально на Windows

```bash
npm install
npm run dist       # соберёт release/bmrng-setup-<version>.exe (без публикации)
```

## Обновления

Приложение при запуске и раз в 6 часов проверяет GitHub Releases. Новая версия
скачивается в фоне; когда готова — в окне появляется баннер «Перезапустить».
Чтобы выпустить обновление, просто поднимите версию и запушьте тег (см. выше).

## Установка на iPhone (libimobiledevice)

`.ipa` ставится через `ideviceinstaller`. В облачной сборке утилиты вкладываются
автоматически (`resources/tools/`). На iPhone нужен Apple Mobile Device Service
(ставится с iTunes с apple.com). Без утилит приложение всё равно скачает и соберёт
`.ipa` — его можно поставить Sideloadly / 3uTools / iMazing. См.
`resources/tools/README.md`.

## Что уже проверено и что нужно проверить на Windows

Проверено на этом этапе (движки протестированы против живого кластера и API):

- транспорт до маков: очередь, TLS, сверка отпечатка, `/ping` живого мака — ✓
- клиент бэкенда: живой `catalog/` (41 приложение с иконками) — ✓
- сборка `.ipa`: вкладывание бинарного `iTunesMetadata.plist` и `sinf` — ✓

Проверяется только на Windows/с iPhone (через CI и на устройстве):

- сам `.exe`-установщик и авто-обновление (electron-builder / electron-updater);
- установка `.ipa` на iPhone через `ideviceinstaller`;
- полный сквозной сценарий с реальным Apple ID и балансом.

## Структура

```
src/main/       главный процесс: backend.js, relay.js, download.js, devices.js,
                flow.js, store.js, main.js, cluster-config.json
src/preload/    безопасный мост в renderer
src/renderer/   интерфейс (index.html, styles.css, app.js, assets/)
build/          иконка приложения
resources/tools libimobiledevice (кладётся при сборке)
.github/        workflow сборки .exe
```
