# tools/

Сюда кладутся утилиты **libimobiledevice** для Windows (`ideviceinstaller.exe`,
`idevice_id.exe`, `ideviceinfo.exe` и все `.dll` рядом). Через них приложение
ставит `.ipa` на подключённый iPhone.

В облачной сборке (GitHub Actions) они скачиваются автоматически — см.
`.github/workflows/release.yml`. Для локальной сборки распакуйте сюда весь архив
`libimobiledevice.*-win-x64.zip` со страницы релизов
<https://github.com/libimobiledevice-win32/imobiledevice-net/releases>.

Без этих утилит приложение всё равно скачает и соберёт `.ipa` — установить его
можно сторонним установщиком (Sideloadly, 3uTools, iMazing). На iPhone также нужен
Apple Mobile Device Service (ставится вместе с iTunes с apple.com).
