#!/bin/bash
# E2E local de folio-say contra el worker de Folio corriendo con `wrangler dev`.
#
# Arranca el worker en background, espera a que responda, ejecuta el CLI real
# (bundle vía esbuild, no mocks) contra ese worker y valida:
#   - --dry-run multi-párrafo usa el chunker real (split por oración, URL sin
#     partir, párrafos decorativos con 0 chunks).
#   - --help sale limpio con exit 0.
#   - reproducción real de una oración: se genera un MP3 válido (>1KB, afinfo
#     lo decodifica como MPEG) y afplay corre hasta el final (exit 0).
#   - toggle play/stop: una segunda invocación mata la primera instancia y su
#     afplay.
#
# Si Edge TTS (el motor upstream sin API key) no responde desde esta máquina —
# el caso conocido es un 403 por versión de Chromium desactualizada en el
# WebSocket handshake — las pruebas de audio real se marcan SKIP (limitación
# de entorno, no bug del CLI) y el script sigue siendo verde mientras el CLI
# haya hecho el POST correcto y haya fallado con un mensaje de error limpio.
#
# Salida: 0 solo si no hubo ningún FAIL. Legible línea por línea (OK/FAIL/SKIP).

set -uo pipefail  # sin -e: cada chequeo se evalúa y se reporta, no aborta el script

CLI_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -P "$CLI_DIR/.." && pwd)"
WORKER_DIR="$REPO_DIR/worker"
CLI_BIN="$CLI_DIR/folio-say"
BASE_URL="http://localhost:8787"
STATE_DIR="$HOME/.cache/folio-say"
WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/folio-say-test.XXXXXX")"
WRANGLER_LOG="$WORK_TMP/wrangler.log"

PASS=0
FAIL=0
SKIP=0
pass() { echo "  OK   $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP $1"; SKIP=$((SKIP + 1)); }

WRANGLER_PID=""
BG_PID=""

# ── Limpieza garantizada ────────────────────────────────────────────────
# Mata cualquier proceso que hayamos dejado colgado (wrangler, su hijo workerd,
# un folio-say/afplay de prueba que quedara vivo) para no ensuciar la máquina
# ni dejar el puerto 8787 ocupado en la siguiente corrida.
cleanup() {
  local ec=$?
  local huerfanos
  [ -n "$BG_PID" ] && kill "$BG_PID" >/dev/null 2>&1
  if [ -n "$WRANGLER_PID" ]; then
    pkill -P "$WRANGLER_PID" >/dev/null 2>&1   # hijo workerd de wrangler dev
    kill "$WRANGLER_PID" >/dev/null 2>&1
  fi
  pkill -f "afplay .*/.cache/folio-say/chunk-" >/dev/null 2>&1
  pkill -f "dist/folio-say.mjs" >/dev/null 2>&1
  # Barrer el puerto SOLO si fuimos nosotros quienes lo ocupamos (WRANGLER_PID
  # seteado). Si el script abortó porque 8787 ya estaba tomado, ese proceso es de
  # alguien más — un `wrangler dev` que el usuario tenía abierto — y matarlo por
  # "limpieza" sería un daño colateral que nadie pidió. Sin `xargs -r`, que es
  # extensión GNU y no existe en todos los macOS.
  if [ -n "$WRANGLER_PID" ]; then
    huerfanos="$(lsof -ti tcp:8787 2>/dev/null || true)"
    [ -n "$huerfanos" ] && kill $huerfanos >/dev/null 2>&1
  fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

echo "== folio-say — E2E local =="
echo "worker log : $WRANGLER_LOG"
echo "tmp        : $WORK_TMP"
echo

# ── 1. Arrancar el worker local ─────────────────────────────────────────
# Antes de nada: si el puerto ya está ocupado no arrancamos ni matamos nada.
# Podría ser el `wrangler dev` del propio usuario; abortar con un mensaje es
# mejor que pelear por el puerto o cerrarle el servidor a media sesión.
if lsof -ti tcp:8787 >/dev/null 2>&1; then
  echo "error: el puerto 8787 ya está ocupado (¿un 'wrangler dev' abierto?)." >&2
  echo "       Ciérralo y vuelve a correr este script." >&2
  exit 1
fi

echo "-- arrancando worker (wrangler dev --port 8787) --"
( cd "$WORKER_DIR" && npx wrangler dev --port 8787 ) >"$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!

ready=0
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 "$BASE_URL/engines"; then
    ready=1
    break
  fi
  if ! kill -0 "$WRANGLER_PID" >/dev/null 2>&1; then
    break # wrangler murió antes de arrancar
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  fail "el worker no respondió en $BASE_URL tras 60s"
  echo "  --- últimas líneas del log de wrangler ---"
  tail -n 60 "$WRANGLER_LOG" | sed 's/^/  /'
  echo
  echo "RESUMEN: $PASS ok, $FAIL fail, $SKIP skip"
  exit 1
fi
pass "worker respondió tras ${i}s en $BASE_URL/engines"

# ── 2. --help limpio ─────────────────────────────────────────────────────
echo
echo "-- folio-say --help --"
HELP_OUT="$("$CLI_BIN" --help 2>&1)"
HELP_EC=$?
if [ "$HELP_EC" = "0" ] && echo "$HELP_OUT" | grep -q "^USO$"; then
  pass "--help sale 0 e imprime USO"
else
  fail "--help (exit=$HELP_EC)"
fi

# ── 3. --dry-run multi-párrafo con el chunker real ───────────────────────
echo
echo "-- --dry-run multi-párrafo (chunker real) --"
# p0: párrafo corto normal (1 chunk).
# p1: separador decorativo "• • •" — sin letras/números → 0 chunks, se salta.
# p2: párrafo largo (>250 chars) para forzar corte por frontera de oración en
#     varios chunks.
# p3: una URL de ~300 chars SIN espacios — no debe partirse a media palabra.
# p4: separador decorativo "***" — también 0 chunks.
DRYRUN_TEXT=$'Este es un parrafo corto de prueba, solo para confirmar que el chunker separa correctamente los parrafos usando la linea en blanco como frontera.\n\n\xe2\x80\xa2 \xe2\x80\xa2 \xe2\x80\xa2\n\nEste segundo parrafo es deliberadamente largo para forzar que el chunker real del repositorio lo divida en varias oraciones distintas, cada una respetando el limite de caracteres configurado para las peticiones de texto a voz. Aqui va una segunda oracion de relleno que ayuda a alcanzar ese tamano con texto natural en espanol, describiendo un escenario cualquiera de prueba de extremo a extremo para el CLI folio-say y su integracion con el backend TTS de Folio. Y una tercera oracion que certifica que el corte ocurre en las fronteras de oracion esperadas, sin partir ninguna palabra a la mitad ni perder los espacios finales del texto original.\n\nhttps://ejemplo.com/una-url-muy-larga-que-no-deberia-partirse-nunca-a-la-mitad-de-una-palabra-aunque-supere-el-limite-de-caracteres-establecido-por-el-chunker-del-repositorio-y-continue-un-poco-mas-alla-del-tope-para-forzar-el-caso-limite-de-prueba\n\n***'

DRYRUN_OUT="$WORK_TMP/dryrun.txt"
printf '%s' "$DRYRUN_TEXT" | "$CLI_BIN" --base "$BASE_URL" --dry-run >"$DRYRUN_OUT" 2>&1
DRYRUN_EC=$?

CHUNK_COUNT="$(grep -oE 'chunks[[:space:]]*: [0-9]+' "$DRYRUN_OUT" | grep -oE '[0-9]+' | head -1)"
HAS_P1="$(grep -c '^\[.*\] p1#' "$DRYRUN_OUT")"
HAS_P4="$(grep -c '^\[.*\] p4#' "$DRYRUN_OUT")"
HAS_P2="$(grep -c '^\[.*\] p2#' "$DRYRUN_OUT")"
P2_CHUNKS="$(grep -oE '^\[.*\] p2#[0-9]+' "$DRYRUN_OUT" | wc -l | tr -d ' ')"

if [ "$DRYRUN_EC" != "0" ]; then
  fail "--dry-run salió con código $DRYRUN_EC"
  sed 's/^/  /' "$DRYRUN_OUT"
else
  pass "--dry-run sale 0"
fi

if [ -n "$CHUNK_COUNT" ] && [ "$CHUNK_COUNT" -ge 4 ]; then
  pass "--dry-run produjo $CHUNK_COUNT chunks (>=4 esperados: p0 + p2 partido + p3 url)"
else
  fail "--dry-run produjo '${CHUNK_COUNT:-<nada>}' chunks, se esperaban >=4"
fi

if [ "$HAS_P1" = "0" ] && [ "$HAS_P4" = "0" ]; then
  pass "los párrafos decorativos (p1 '• • •', p4 '***') dieron 0 chunks y se saltaron"
else
  fail "un párrafo decorativo generó chunks (p1=$HAS_P1, p4=$HAS_P4)"
fi

if [ "$P2_CHUNKS" -ge 2 ]; then
  pass "el párrafo largo (p2) se partió en $P2_CHUNKS chunks por frontera de oración"
else
  fail "el párrafo largo (p2) no se partió (solo $P2_CHUNKS chunk[s])"
fi

# La URL (p3) no debe aparecer partida: el texto de su chunk debe contener la
# URL completa de un tirón (sin espacio insertado a media cadena).
if grep -q 'https://ejemplo\.com/una-url-muy-larga-que-no-deberia-partirse-nunca-a-la-mitad-de-una-palabra-aunque-supere-el-limite-de-caracteres-establecido-por-el-chunker-del-repositorio-y-continue-un-poco-mas-alla-del-tope-para-forzar-el-caso-limite-de-prueba' "$DRYRUN_OUT"; then
  pass "la URL larga sin espacios viajó completa en un solo chunk, sin partirse"
else
  fail "la URL larga no aparece intacta en la salida de --dry-run"
fi

# ── 4. Probe directo al worker: ¿Edge TTS upstream responde desde aquí? ──
echo
echo "-- probe directo POST $BASE_URL/tts (edge, sin CLI) --"
PROBE_BODY='{"text":"Prueba de sonido.","voiceId":"es-MX-DaliaNeural","engine":"edge","speed":1,"format":"mp3"}'
PROBE_FILE="$WORK_TMP/probe.bin"
PROBE_STATUS="$(curl -s -o "$PROBE_FILE" -w '%{http_code}' --max-time 30 -X POST "$BASE_URL/tts" \
  -H 'Content-Type: application/json' -d "$PROBE_BODY")"

EDGE_OK=0
if [ "$PROBE_STATUS" = "200" ] && [ -s "$PROBE_FILE" ] && afinfo "$PROBE_FILE" >/dev/null 2>&1; then
  EDGE_OK=1
  pass "Edge TTS upstream responde: HTTP 200, MP3 válido ($(wc -c <"$PROBE_FILE" | tr -d ' ') bytes)"
else
  skip "Edge TTS upstream no disponible desde este entorno (HTTP $PROBE_STATUS) — limitación de entorno, no bug del CLI"
  echo "  --- cuerpo de la respuesta (primeros 300 bytes) ---"
  head -c 300 "$PROBE_FILE" 2>/dev/null | sed 's/^/  /'
  echo
fi

# ── 5. Reproducción real de una oración vía el CLI ────────────────────────
echo
echo "-- reproducción real (una oración) --"
if [ "$EDGE_OK" = "1" ]; then
  SENTENCE="Esta es una prueba corta de reproduccion con folio say en espanol."
  PLAY_LOG="$WORK_TMP/play.log"
  "$CLI_BIN" --base "$BASE_URL" --voice dalia -- "$SENTENCE" >"$PLAY_LOG" 2>&1 &
  BG_PID=$!

  CAPTURED=""
  for i in $(seq 1 300); do # hasta 30s (100ms * 300) para tolerar latencia de red
    f="$(ls "$STATE_DIR"/chunk-*.mp3 2>/dev/null | head -1)"
    if [ -n "$f" ]; then
      cp "$f" "$WORK_TMP/captured.mp3" 2>/dev/null && [ -s "$WORK_TMP/captured.mp3" ] && CAPTURED=1 && break
    fi
    kill -0 "$BG_PID" >/dev/null 2>&1 || break # el CLI ya terminó (con o sin error)
    sleep 0.1
  done

  wait "$BG_PID"
  PLAY_EC=$?
  BG_PID=""

  if [ "$CAPTURED" = "1" ]; then
    SIZE="$(wc -c <"$WORK_TMP/captured.mp3" | tr -d ' ')"
    if [ "$SIZE" -gt 1024 ] && afinfo "$WORK_TMP/captured.mp3" >/dev/null 2>&1; then
      pass "se generó un MP3 temporal válido (${SIZE} bytes, afinfo lo decodifica)"
    else
      fail "el MP3 temporal capturado no es válido (${SIZE} bytes o afinfo falló)"
    fi
  else
    fail "no se detectó ningún chunk-*.mp3 temporal durante la reproducción"
  fi

  if [ "$PLAY_EC" = "0" ]; then
    pass "el CLI terminó con exit 0 (afplay reprodujo y cerró limpio)"
  else
    fail "el CLI terminó con exit $PLAY_EC — log:"
    sed 's/^/  /' "$PLAY_LOG"
  fi

  # nada debe quedar en el directorio de estado tras una corrida normal
  LEFTOVER="$(ls "$STATE_DIR"/chunk-*.mp3 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$LEFTOVER" = "0" ]; then
    pass "$STATE_DIR quedó sin mp3 temporales tras terminar"
  else
    fail "quedaron $LEFTOVER mp3 temporales en $STATE_DIR"
  fi
else
  skip "reproducción real omitida (Edge TTS no disponible en este entorno)"

  # Igual verificamos que el CLI intenta el POST y falla con un mensaje de
  # usuario limpio (sin traza), no un crash — eso SÍ sería bug del CLI.
  ERR_LOG="$WORK_TMP/play-error.log"
  "$CLI_BIN" --base "$BASE_URL" --voice dalia -- "Prueba." >"$ERR_LOG" 2>&1
  ERR_EC=$?
  if grep -qi '/tts' "$WRANGLER_LOG"; then
    pass "el worker registró el POST /tts del CLI (ver $WRANGLER_LOG)"
  else
    fail "el worker no registró ningún POST /tts — el CLI no llegó a mandar la petición"
  fi
  if [ "$ERR_EC" = "1" ] && grep -qE '^folio-say: ' "$ERR_LOG" && ! grep -qE 'at .*\(.*:[0-9]+:[0-9]+\)' "$ERR_LOG"; then
    pass "el CLI reportó el fallo con mensaje de usuario limpio, exit 1, sin traza"
  else
    fail "el CLI no manejó el fallo del backend con un mensaje limpio — log:"
    sed 's/^/  /' "$ERR_LOG"
  fi
fi

# ── 6. Toggle: la misma invocación detiene la lectura en curso ───────────
echo
echo "-- toggle play/stop --"
if [ "$EDGE_OK" = "1" ]; then
  LONG_TEXT="Este es un texto largo pensado para que la lectura dure varios segundos mientras se prueba el boton de alternancia entre reproducir y detener. Primera oracion de relleno para ganar tiempo de sobra. Segunda oracion de relleno para ganar mas tiempo todavia y asegurar que siga sonando. Tercera oracion que asegura que el chunker real produzca mas de un fragmento de audio consecutivo. Cuarta oracion adicional solo para estirar la duracion total de la lectura."

  "$CLI_BIN" --base "$BASE_URL" --voice dalia -- "$LONG_TEXT" >"$WORK_TMP/toggle1.log" 2>&1 &
  TOGGLE_PID1=$!
  BG_PID=$TOGGLE_PID1

  afplay_up=0
  for i in $(seq 1 300); do
    if pgrep -f "afplay .*/.cache/folio-say/chunk-" >/dev/null 2>&1; then
      afplay_up=1
      break
    fi
    kill -0 "$TOGGLE_PID1" >/dev/null 2>&1 || break # murió antes de sonar
    sleep 0.1
  done

  if [ "$afplay_up" = "1" ]; then
    pass "la primera instancia empezó a sonar (afplay activo)"

    "$CLI_BIN" --base "$BASE_URL" </dev/null >"$WORK_TMP/toggle2.log" 2>&1
    TOGGLE2_EC=$?

    wait "$TOGGLE_PID1" 2>/dev/null
    BG_PID=""
    sleep 0.3 # margen breve para que el handler de SIGTERM termine de limpiar

    if [ "$TOGGLE2_EC" = "0" ] && grep -q "lectura detenida" "$WORK_TMP/toggle2.log"; then
      pass "la segunda invocación reporta 'lectura detenida' y sale 0"
    else
      fail "la segunda invocación no reportó el stop esperado (exit=$TOGGLE2_EC) — log:"
      sed 's/^/  /' "$WORK_TMP/toggle2.log"
    fi

    if pgrep -f "afplay .*/.cache/folio-say/chunk-" >/dev/null 2>&1; then
      fail "el afplay de la primera instancia seguía sonando tras el stop"
    else
      pass "el afplay de la primera instancia se detuvo"
    fi

    if kill -0 "$TOGGLE_PID1" >/dev/null 2>&1; then
      fail "el proceso node de la primera instancia seguía vivo tras el stop"
    else
      pass "el proceso node de la primera instancia terminó"
    fi

    LEFTOVER="$(ls "$STATE_DIR"/chunk-*.mp3 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$LEFTOVER" = "0" ]; then
      pass "$STATE_DIR quedó sin mp3 temporales tras el toggle"
    else
      fail "quedaron $LEFTOVER mp3 temporales en $STATE_DIR tras el toggle"
    fi
  else
    fail "la primera instancia nunca llegó a sonar (afplay) — no se pudo probar el toggle real"
    kill "$TOGGLE_PID1" >/dev/null 2>&1
    wait "$TOGGLE_PID1" 2>/dev/null
    BG_PID=""
  fi
else
  skip "toggle con audio real omitido (Edge TTS no disponible en este entorno)"
fi

# ── Resumen ────────────────────────────────────────────────────────────
echo
echo "== RESUMEN =="
echo "  ok=$PASS  fail=$FAIL  skip=$SKIP"
if [ "$EDGE_OK" != "1" ]; then
  echo "  NOTA: Edge TTS upstream no respondió desde este entorno (probable 403 por"
  echo "  versión de Chromium en el handshake WebSocket) — las pruebas de audio real"
  echo "  se omitieron como limitación de entorno, no como falla del CLI."
fi

if [ "$FAIL" = "0" ]; then
  echo "TODO OK"
  exit 0
else
  echo "HUBO FALLAS"
  exit 1
fi
