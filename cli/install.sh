#!/bin/bash
# Instalador de folio-say: bundle, symlink en PATH y Quick Action de Automator.
#
# Idempotente a propósito: correrlo dos veces deja el sistema en el mismo
# estado (recompila el bundle, re-crea el symlink si apunta mal, regenera el
# .workflow). Nada de esto pide sudo ni toca dotfiles del usuario.
set -euo pipefail

CLI_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -P "$CLI_DIR/.." && pwd)"
WRAPPER="$CLI_DIR/folio-say"
BUNDLE="$CLI_DIR/dist/folio-say.mjs"
ESBUILD="$REPO_DIR/node_modules/.bin/esbuild"
BIN_DIR="$HOME/.local/bin"
LINK="$BIN_DIR/folio-say"
STATE_DIR="$HOME/.cache/folio-say"
NODE_HINT="$STATE_DIR/node-path"
SERVICE_NAME="Leer con Folio"
SERVICE_DIR="$HOME/Library/Services/$SERVICE_NAME.workflow"

# Escapa un texto para meterlo en un <string> de plist. La ruta del repo podría
# traer &, < o > y dejaría el XML inválido (plutil -lint lo cazaría, pero el
# error sería incomprensible).
xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  printf '%s' "$s"
}

# Cita una ruta para incrustarla en un SCRIPT de shell. COMMAND_STRING del
# Quick Action no es un argv: es el texto del script que bash ejecuta. La ruta
# de este repo trae un espacio ("Claude Cowork"), así que sin comillas bash
# intentaba correr ".../Claude" y el atajo moría con "No such file or directory".
shell_quote() {
  local s=${1//\'/\'\\\'\'}
  printf "'%s'" "$s"
}

echo "== folio-say: instalando =="

# --- (a) node: resolver y registrar la ruta ---------------------------------
# El Quick Action corre bajo launchd con PATH mínimo (/usr/bin:/bin:/usr/sbin:
# /sbin): node en ~/.local/bin, Homebrew, nvm o volta NO aparece ahí. Este
# install corre en la terminal del usuario, que SÍ lo tiene: registramos la ruta
# absoluta para que el wrapper la use cuando el PATH no ayude.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: no encontré 'node' en el PATH. Instálalo y vuelve a correr este script." >&2
  exit 1
fi
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
printf '%s\n' "$NODE_BIN" > "$NODE_HINT"
echo "-- node: $NODE_BIN (registrado en $NODE_HINT)"

# --- (b) bundle con esbuild -------------------------------------------------
# Se reconstruye siempre en el install (a diferencia del wrapper, que solo
# recompila si detecta el bundle viejo o ausente): instalar debe dejar el
# bundle al día con la fuente, sin depender de timestamps.
echo "-- bundleando cli/folio-say.ts -> cli/dist/folio-say.mjs"
if [ ! -f "$ESBUILD" ]; then
  echo "error: falta esbuild en $REPO_DIR/node_modules. Corre 'npm install' ahí." >&2
  exit 1
fi
mkdir -p "$CLI_DIR/dist"
(
  cd "$CLI_DIR"
  # Por ruta directa y con el node ya resuelto: `npx` sin el paquete instalado
  # se cuelga pidiendo confirmación, y el bin de esbuild es "#!/usr/bin/env node".
  "$NODE_BIN" "$ESBUILD" folio-say.ts \
    --bundle \
    --platform=node \
    --format=esm \
    --outfile=dist/folio-say.mjs
) >&2
if [ ! -s "$BUNDLE" ]; then
  echo "error: el bundle no se generó (dist/folio-say.mjs vacío o ausente)" >&2
  exit 1
fi
echo "   ok: $BUNDLE"

# Smoke check: que el wrapper resuelva node y ejecute el bundle DE VERDAD. Sin
# esto, un bundle roto o un node irresoluble solo se descubría al presionar el
# atajo, donde no hay stderr que leer. --help no toca red, audio ni estado.
if ! "$WRAPPER" --help >/dev/null; then
  echo "error: el wrapper no pudo ejecutar el bundle (revisa el mensaje de arriba)" >&2
  exit 1
fi
echo "   ok: '$WRAPPER --help' corre limpio"

# --- (c) symlink en ~/.local/bin --------------------------------------------
mkdir -p "$BIN_DIR"
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$WRAPPER" ]; then
  echo "-- symlink ya existe y apunta bien: $LINK -> $WRAPPER"
else
  # -f pisa un symlink previo (versión vieja) o un archivo suelto con el mismo
  # nombre; no tocamos nada que no sea este link puntual.
  ln -sf "$WRAPPER" "$LINK"
  echo "-- symlink creado: $LINK -> $WRAPPER"
fi

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "   aviso: $BIN_DIR no está en tu PATH. Este instalador NO toca tus" >&2
  echo "   dotfiles; agrégalo tú a mano si quieres invocar 'folio-say' en" >&2
  echo "   una terminal nueva, p. ej. en ~/.zshrc:" >&2
  echo "     export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
fi

# --- (d) Quick Action de Automator ------------------------------------------
# Formato validado contra Quick Actions reales instaladas en este mismo Mac
# (~/Library/Services/*.workflow: una basada en texto -> NSSendTypes con
# public.utf8-plain-text, y dos con acción "Run Shell Script" real ->
# BundleIdentifier com.apple.RunShellScript).
#
# inputMethod: 0 = "pasar la entrada a stdin", 1 = "como argumentos". Lo confirma
# el AMDefaultParameters de /System/Library/Automator/Run Shell Script.action
# (inputMethod=0 junto a COMMAND_STRING vacío, que es el default "to stdin" de la
# UI) y los dos workflows reales de esta máquina, que usan inputMethod=1 y leen
# "$@". Aquí se usa 0 (stdin) y aun así el script referencia "$@": así funciona
# igual si alguien cambia el modo desde Automator.
#
# Se regenera completa en cada run: es contenido derivado, no algo que el
# usuario edite a mano.
echo "-- generando Quick Action: $SERVICE_DIR"
rm -rf "$SERVICE_DIR"
mkdir -p "$SERVICE_DIR/Contents"

SERVICE_NAME_XML="$(xml_escape "$SERVICE_NAME")"
# El script que Automator ejecuta: ruta CITADA + "$@" para el modo argumentos.
# Sin argumentos (modo stdin) queda `'/ruta/folio-say' --`, y el `--` protege al
# texto que empiece con guion de ser leído como opción.
# stderr → service.log: un Quick Action que falla no muestra NADA al usuario
# (aprendido en campo: "no arranca" sin pista alguna) — con el log, el
# diagnóstico es leer ~/.cache/folio-say/service.log.
SERVICE_LOG="$HOME/.cache/folio-say/service.log"
COMMAND_STRING_XML="$(xml_escape "mkdir -p $(shell_quote "$(dirname "$SERVICE_LOG")"); { echo \"== \$(date '+%F %T') servicio invocado (args=\$#)\"; $(shell_quote "$WRAPPER") -- \"\$@\"; echo \"== exit=\$?\"; } >> $(shell_quote "$SERVICE_LOG") 2>&1")"

cat > "$SERVICE_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>English</string>
	<key>CFBundleIdentifier</key>
	<string>com.foliosay.leerconfolio</string>
	<key>CFBundleName</key>
	<string>$SERVICE_NAME_XML</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>$SERVICE_NAME_XML</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSSendTypes</key>
			<array>
				<string>public.utf8-plain-text</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
PLIST

INPUT_UUID="$(uuidgen)"
OUTPUT_UUID="$(uuidgen)"
ACTION_UUID="$(uuidgen)"

# Automator pipetea el texto seleccionado al stdin del script COMMAND_STRING
# (inputMethod=0), y el wrapper ya sabe leer stdin cuando no hay TTY.
# shell=/bin/bash según lo acordado (el wrapper mismo es un script bash).
cat > "$SERVICE_DIR/Contents/document.wflow" <<WFLOW
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>521</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>$COMMAND_STRING_XML</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>0</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>$INPUT_UUID</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
				</array>
				<key>OutputUUID</key>
				<string>$OUTPUT_UUID</string>
				<key>UUID</key>
				<string>$ACTION_UUID</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
			</dict>
			<key>isViewVisible</key>
			<true/>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.text</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<false/>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
WFLOW

# Validar los dos plists del workflow antes de darlo por bueno.
if ! plutil -lint "$SERVICE_DIR/Contents/Info.plist" >&2; then
  echo "error: Info.plist del Quick Action no pasó plutil -lint" >&2
  exit 1
fi
if ! plutil -lint "$SERVICE_DIR/Contents/document.wflow" >&2; then
  echo "error: document.wflow del Quick Action no pasó plutil -lint" >&2
  exit 1
fi
echo "   ok: $SERVICE_DIR (Info.plist y document.wflow validados con plutil -lint)"

# Avisar a Launch Services / pbs que hay un Service nuevo para que aparezca
# sin tener que cerrar sesión. Si falla (pbs no disponible), no es fatal: el
# usuario lo verá de todos modos al reabrir el menú Servicios.
/System/Library/CoreServices/pbs -flush >/dev/null 2>&1 || true

echo ""
echo "== listo =="
echo ""
echo "Pasos manuales que faltan:"
echo "  1. Ajustes del Sistema -> Teclado -> Atajos de teclado -> Servicios"
echo "     -> busca \"$SERVICE_NAME\" (categoría Texto) y asígnale un atajo."
echo "  2. Corre 'folio-say --setup' para configurar backend, service token,"
echo "     voz y velocidad (interactivo, va a $HOME/.config/folio-say/config.json)."
