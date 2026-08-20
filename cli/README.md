# folio-say

CLI de macOS que lee texto en voz alta con el backend TTS de Folio. Recibe el
texto por stdin o como argumento, lo parte en chunks con el chunker real del
repo (`src/agents/chunker.ts`), pide el audio al backend y lo reproduce con
`afplay`. Se invoca desde el Quick Action de Automator **"Leer con Folio"**,
que aparece en el menú Servicios de cualquier app con texto seleccionado.

## Instalación

Requisitos: macOS, `node` instalado, y las dependencias del repo bajadas
(`npm install` en la raíz — de ahí sale esbuild, que es lo que arma el bundle).

```bash
cli/install.sh
```

Córrelo **desde tu terminal habitual**, la que tiene `node` en el `PATH`. Es
idempotente — correrlo de nuevo no rompe nada, solo deja todo al día. Hace
cuatro cosas:

1. Registra la ruta absoluta de tu `node` en `~/.cache/folio-say/node-path`.
   El Quick Action corre bajo launchd con un `PATH` mínimo
   (`/usr/bin:/bin:/usr/sbin:/sbin`), donde un node de `~/.local/bin`,
   Homebrew, nvm o volta **no** aparece; sin esa ruta el atajo moriría con
   `node: command not found` y sin nadie que lea el error.
2. Bundlea `folio-say.ts` con esbuild a `cli/dist/folio-say.mjs` (los imports
   del repo no llevan extensión, así que el type-stripping nativo de Node no
   los resuelve; hace falta el bundle) y verifica que el wrapper realmente
   ejecuta el bundle (`folio-say --help`).
3. Crea el symlink `~/.local/bin/folio-say` → `cli/folio-say` (ruta absoluta).
   Si `~/.local/bin` no está en tu `PATH`, el instalador te avisa pero **no**
   toca tus dotfiles — agrégalo tú a mano si quieres invocar `folio-say`
   directo desde una terminal nueva.
4. Genera el Quick Action de Automator en
   `~/Library/Services/Leer con Folio.workflow` (recibe texto plano y se lo
   pasa por stdin al wrapper, invocado por ruta absoluta y entre comillas —
   la ruta de este repo trae un espacio). Se regenera completo en cada
   `install.sh` — no lo edites a mano, tus cambios se perderían en el
   siguiente install.

Tras instalar, el Quick Action puede tardar un momento en aparecer en el menú
Servicios; si no aparece, cierra sesión y vuelve a entrar (o corre
`/System/Library/CoreServices/pbs -flush`, que `install.sh` ya intenta por su
cuenta).

## Configurar el backend (producción)

Producción (`https://folio.thestandardcurve.com/api`) está detrás de
Cloudflare Access. El CLI se autentica con un *service token* — sin eso, el
backend responde 401/403 y el CLI dice "credenciales inválidas o sesión
expirada".

1. **Crear el service token.** Zero Trust → Access → Service Auth → *Add a
   service token* → nómbralo `folio-say`. Cloudflare muestra el **Client ID**
   y el **Client Secret** UNA sola vez — cópialos ahí mismo, no se pueden
   recuperar después (si los pierdes, hay que crear un token nuevo).
2. **Autorizar el token en la app existente de Folio.** En la aplicación de
   Access que ya protege Folio (no crear una nueva), añade una política:
   - **Action**: `Service Auth`
   - **Include**: el service token `folio-say` que acabas de crear.

   Esto deja las políticas de usuario (login normal por navegador) intactas
   y solo abre una puerta adicional para llamadas máquina-a-máquina.
3. **Correr `folio-say --setup`** (ver abajo) y pegar el Client ID / Client
   Secret cuando lo pida.

## `folio-say --setup`

Configuración interactiva — necesita terminal real (no funciona por pipe, lo
avisa si lo intentas). Pide, en orden:

- URL base del backend (producción trae `/api`; dev local es
  `http://localhost:8787`, sin `/api`).
- `CF-Access-Client-Id` / `CF-Access-Client-Secret` (opcionales — vacíos si
  solo vas a usar el worker local sin Access; Enter en blanco conserva la
  credencial anterior si ya había una).
- Voz por defecto: `dalia` | `jorge` | `aria` | `guy` (o un `voiceId` completo
  de Edge TTS, p. ej. `es-MX-DaliaNeural`).
- Velocidad por defecto (rango 0.5–3).

Guarda todo en `~/.config/folio-say/config.json` con permisos `600` (ahí vive
el secret, de ahí el modo restringido).

## Asignar el atajo de teclado

Ajustes del Sistema → Teclado → Atajos de teclado → Servicios → busca
**"Leer con Folio"** (categoría Texto) → asígnale una combinación libre.

**El mismo atajo hace play y stop.** Selecciona texto y dispáralo para
escuchar; dispáralo de nuevo mientras lee (sin selección, o con cualquier
selección) para callarlo — el CLI usa un pidfile para saber si ya hay una
lectura en curso.

## Uso desde terminal

```bash
folio-say "texto a leer"          # argumento directo
pbpaste | folio-say                # desde el portapapeles
folio-say --stop                   # detiene la lectura en curso
folio-say --voice jorge "hola"     # voz puntual, sin tocar la config guardada
folio-say --speed 1.25 "hola"      # velocidad puntual
folio-say --base http://localhost:8787 "hola"   # backend puntual (dev local)
folio-say --dry-run "texto largo"  # imprime los chunks/requests, sin red ni audio
folio-say -- "--texto que empieza con guiones"  # todo lo que sigue a -- es texto
folio-say --help
```

`--voice` y `--speed` en la línea de comandos son solo para esa corrida — no
sobreescriben lo guardado por `--setup`.

## Dev local

```bash
cd worker && npx wrangler dev
```

El worker local responde `/tts` directo, sin Cloudflare Access. Configura
`baseUrl=http://localhost:8787` en `--setup` (o usa `--base` puntual) y deja
`CF-Access-Client-Id` / `Client-Secret` vacíos — el CLI solo manda esos
headers si hay credenciales guardadas.

Para probar el flujo completo end-to-end contra el worker local:

```bash
cli/test-local.sh
```

## Troubleshooting

- **401 / "credenciales inválidas o sesión expirada"** — revisa que la
  política Service Auth de la Access app de Folio incluya el token
  `folio-say`, y que el Client ID/Secret en `~/.config/folio-say/config.json`
  sean los que Cloudflare mostró al crear el token (no se pueden recuperar
  después de cerrados; si se perdieron, crea un token nuevo y vuelve a correr
  `--setup`).
- **429** — el backend está limitando peticiones; el CLI ya reintenta unas
  cuantas veces con el `retryAfterMs` que manda el servidor. Si persiste,
  espera.
- **Sin configuración** — "corre folio-say --setup". Pasa también si
  `config.json` quedó corrupto o con un valor del tipo equivocado (`baseUrl`
  sin `http://`, un secret con salto de línea): el CLI dice cuál campo está
  mal y `--setup` lo reescribe desde cero sin quejarse del archivo viejo.
- **El atajo no hace nada (pero `folio-say` sí funciona en la terminal)** — casi
  siempre es `node`: el Quick Action no hereda tu `PATH`. Vuelve a correr
  `cli/install.sh` desde tu terminal habitual para reregistrar la ruta de node
  en `~/.cache/folio-say/node-path`. Si cambiaste de gestor de versiones (nvm,
  volta, fnm) o actualizaste node, hay que reinstalar.
- **No suena nada** — confirma que `afplay` funciona en tu Mac
  (`afplay /System/Library/Sounds/Ping.aiff` debería sonar). Si el Quick
  Action corre pero no hay audio, revisa permisos de Automator/Servicios en
  Ajustes del Sistema → Privacidad y Seguridad → Automatización.
- **El Quick Action no aparece en el menú Servicios** — vuelve a correr
  `cli/install.sh`, luego cierra sesión y entra de nuevo (o espera: `pbs`
  puede tardar un poco en refrescar el menú).
- **Cambié `folio-say.ts` y "no pasó nada"** — el wrapper solo recompila si
  detecta el bundle desactualizado por timestamp; si tocaste algo en
  `src/agents/chunker.ts` (fuera de `cli/`), borra `cli/dist/` a mano o corre
  `cli/install.sh` de nuevo para forzar el rebuild.
- **"falta esbuild en .../node_modules"** — el bundle se arma con el esbuild que
  ya trae el repo (dependencia de vite). Corre `npm install` en la raíz del
  repo. El wrapper **no** usa `npx` a propósito: sin el paquete instalado, npx
  se queda esperando un "Ok to proceed?" que en un atajo de teclado nadie ve.
