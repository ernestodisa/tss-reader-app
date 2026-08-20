# FolioSay (v1, barra de menús)

App de barra de menús para macOS que lee en voz alta el texto seleccionado.
Motor nativo en Swift (AVQueuePlayer, descarga con prefetch y encolado gapless),
contra el **mismo backend y el mismo archivo de configuración** que el CLI v0 de
`../cli/` (`~/.config/folio-say/config.json`).

## Requisitos

- macOS 13+ y Xcode Command Line Tools (para `swift build`).
- Config del CLI ya creada: corre `folio-say --setup` una vez. Sin credenciales,
  la app arranca pero el menú muestra `Sin credenciales — corre folio-say --setup`.

## Build

```bash
./make-app.sh
```

Compila en release y deja `dist/FolioSay.app` firmado ad-hoc.

## Instalación

```bash
cp -R dist/FolioSay.app /Applications/
```

O ábrela in situ: `open dist/FolioSay.app`. (La firma ad-hoc es lo que hace que
el permiso de Accesibilidad sobreviva entre recompilaciones; si mueves el
bundle, macOS lo trata como app nueva y pide el permiso otra vez.)

## Primer arranque

macOS pedirá permiso de **Accesibilidad**. Concédelo en
**Ajustes del Sistema → Privacidad y seguridad → Accesibilidad** y vuelve a
abrir la app.

- Es necesario para **Leer selección**: la app simula ⌘C para capturar lo
  seleccionado en la app frontal (y restaura tu portapapeles después).
- **Leer portapapeles** funciona sin ese permiso.

La app no aparece en el Dock: vive en la barra de menús (ícono de libro).

## Uso

- Atajo global **⌃⌥⌘L**: lee la selección; si ya está leyendo, detiene; si está
  pausada, reanuda. Si otra app ya tiene tomado el atajo, el menú lo avisa y
  todo sigue disponible desde el menú.
- Menú: pausar/reanudar/detener, submenú **Voz** (dalia, jorge, aria, guy) y
  **Velocidad** (0.75× a 2×). La velocidad se aplica en vivo; el cambio de voz
  aplica a la **próxima** lectura (no corta la que va sonando). Ambas se guardan
  en el config compartido con el CLI.
- El ícono refleja el estado: libro (listo), flechas (cargando), onda
  (leyendo), pausa, triángulo (error — el mensaje queda en el tooltip y en el
  menú).

## Convivencia con la v0

El Quick Action / CLI v0 sigue funcionando. Al empezar a reproducir, FolioSay
**calla cualquier lectura del Quick Action** que siga sonando (verifica el pid
contra su línea de comando antes de matarlo, para no tocar procesos ajenos), y
usa archivos temporales con prefijo propio para no pisar los del CLI.
