#!/bin/bash
# Compila FolioSay en release y arma un .app mínimo listo para /Applications.
#
# OJO: la ruta del repo contiene un ESPACIO ("Claude Cowork"), así que TODA
# expansión va entre comillas. Sin eso, swift build recibe dos argumentos.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$HERE/FolioSay"
DIST="$HERE/dist"
APP="$DIST/FolioSay.app"

echo "==> Compilando (release)…"
swift build -c release --package-path "$PKG"

BIN="$(swift build -c release --package-path "$PKG" --show-bin-path)/FolioSay"
[ -x "$BIN" ] || { echo "No se encontró el binario en: $BIN" >&2; exit 1; }

echo "==> Armando $APP…"
# Bundle desde cero: si quedaran restos de un build viejo, la firma ad-hoc
# heredaría archivos que ya no corresponden.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/FolioSay"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>FolioSay</string>
    <key>CFBundleDisplayName</key>
    <string>FolioSay</string>
    <key>CFBundleIdentifier</key>
    <string>com.thestandardcurve.foliosay</string>
    <key>CFBundleExecutable</key>
    <string>FolioSay</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- Agente: sin ícono en el Dock ni cambiador de apps. -->
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Identidad estable si existe (creada una vez en el llavero — ver README):
# con ella TCC conserva el permiso de Accesibilidad entre recompilaciones.
# La firma ad-hoc NO lo logra (su huella cambia en cada build y macOS trata
# la app como nueva); es solo el fallback.
IDENTITY="FolioSay Dev"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
    echo "==> Firmando con \"$IDENTITY\"…"
    codesign --force --sign "$IDENTITY" --deep "$APP"
else
    echo "==> Firmando ad-hoc (sin identidad \"$IDENTITY\"; Accesibilidad se pierde en cada build)…"
    codesign --force --sign - --deep "$APP"
fi

echo "Listo: $APP"
echo "Instala con:  cp -R \"$APP\" /Applications/   (o ábrelo aquí con: open \"$APP\")"
