# Auditoría Folio — 2026-07-22

> **ESTADO (misma fecha, sesión de fixes):** los 44 hallazgos fueron corregidos en 7 fases
> secuenciales multiagente (working tree sin commitear; ver diff contra `9942029`).
> Durante el smoke de verificación se detectó y corrigió un 45º problema: la interacción
> B3×A5 en `endOnStall` (EPS de 24ms demasiado estricto — el elemento se estanca ~100-150ms
> antes del endMs calculado y el fin nunca disparaba; ahora el margen es medio chunk, tope
> 1500ms). Verificado en preview con libro sintético: extracción, seek por click, karaoke
> por palabra, avance de párrafos y cierre limpio al fin del documento con motor MSE.
> Pendiente: /publicar cuando Ernesto lo decida, prueba en dispositivos reales
> (iPhone=clásico, Android Brave=MSE), y borrar el worker viejo `speechify-tts` del
> dashboard CF personal (B14, acción manual).

Alcance: diff `6f98683..9942029` (maratón del 21-jul) + módulos completos de las zonas calientes del handoff. Método: 5 auditores paralelos por zona (PlayerBar/carreras, motor MSE, auto-sync/worker, interacciones UI, barrido del resto) + pasada de verificación manual de todos los hallazgos ALTA contra el código. Build (`tsc -b && vite build`) y typecheck del worker pasan limpios — todo lo de abajo es lógica de runtime.

Convención: ✅ = verificado línea por línea en la pasada de verificación; los demás vienen con evidencia citada del auditor de zona.

---

## Dos causas raíz transversales

**R1 — El protocolo de invalidación descansa solo en `generationId`, y no todos los caminos lo incrementan.** `seekToParagraph` sí bumpea; `nextParagraph`, `prevParagraph`, `nextChapter`, `prevChapter` y `closeReader` NO (comentario explícito en `playback-store.ts:130-132`). `fullStop()` corta el audio pero no las promesas en vuelo, y los guards (`generationId === chain.gen`, identidad de `chainRef`) no distinguen reintentos sobre la misma chain. De aquí salen A1, A2, A3 y varios medios.

**R2 — Auto-sync degrada en silencio por diseño, sin cola ni reintento.** Cualquier fallo (CORS en dev, 413 por tamaño, red caída, abort en pagehide) se traga sin log, sin marca "pendiente" y sin UI de estado. El usuario cree que sincroniza y no es cierto. De aquí salen A7–A11.

---

## ALTA

### Reproducción (motor clásico + cadena de chunks)

**A1 ✅ — Navegación no bumpea generación → audio del párrafo viejo resucita.**
`PlayerBar.tsx:104,112,271-320` + `playback-store.ts:97-155`. En un gap entre chunks sin pre-encolado (red lenta), `isBuffering` es false y ⏭/⏮ están habilitados. `handleNext` hace `fullStop + nextParagraph + loadAndPlayParagraph`, pero como la generación no cambió, el fetch viejo en vuelo pasa el guard y hace `load()+play()` con el chunk del párrafo anterior: audio de un párrafo, karaoke de otro, o doble arranque según el orden de resolución.

**A2 ✅ — Cerrar el libro no invalida cargas en vuelo → audio huérfano sonando en la Biblioteca.**
`ReaderView.tsx:208-212` (`closeReader` sin bump) + `player.ts:56-65,219-222`. Tocas ▶, cierras el libro con el fetch TTS en vuelo; el fetch resuelve, el guard pasa, `getAudio()` RECREA el elemento tras `destroy()` → audio reproduciéndose en la Biblioteca con `isPlaying=true` y la cadena avanzando párrafos del libro cerrado (los callbacks del singleton no se anulan en destroy).

**A3 — `queueUpcoming` huérfano pasa los gates → chunk duplicado y chunk saltado, karaoke corrido.**
`PlayerBar.tsx:163-208,433-443` + `mse-player.ts:208-219`. Si el chunk actual termina antes de que resuelva el pre-encolado, `playChunkFromChain` re-fetchea el mismo chunk y lanza OTRO `queueUpcoming` sobre el MISMO objeto chain; el gate (`gen === chain.gen && chainRef.current === chain`) no tiene token por invocación, así que el fetch viejo también encola. Clásico: puede reemplazar c2 por c1 → c1 suena dos veces, c2 se salta, `wordOffset` corrido (karaoke desincronizado el resto del párrafo). MSE: anexa → SourceBuffer con chunks repetidos/fuera de orden, irreversible.

### Motor MSE (Android)

**A4 ✅ — El guard `_tearingDown` es síncrono pero el `error` espurio del teardown es asíncrono → salto de párrafo falso.**
`mse-player.ts:296-307` + `109-114`. `removeAttribute('src')+load()` emite un `error` espurio SIEMPRE como tarea asíncrona (el propio motor clásico lo documenta y lo resuelve desregistrando `onerror` antes — `player.ts:174-178`); el flag se apaga en el mismo bloque síncrono y `load()` pone `_hasCurrent=true` en el mismo tick. Cuando el evento llega, dispara `errorCallback` → `skipToNextAfterError` → salta un párrafo sano. Ventana garantizada en cada camino load()→load().

**A5 ✅ — `endOnStall`: underrun de red = falso fin de stream.**
`mse-player.ts:405-416`. `pending` solo sabe de chunks ya descargados; con el fetch del siguiente chunk EN VUELO, un `waiting`/`stalled` real (red lenta) pasa los tres guards — y a diferencia de `checkProgress`, no compara `posMs` contra `last.endMs`. Consecuencias: (a) PlayerBar responde con `load()` = reasignar `src`, exactamente lo que Chrome Android bloquea en background → con pantalla apagada la reproducción muere (posible causa del síntoma Android); (b) el fetch tardío después encola su chunk al stream nuevo → doble append, `nextIndex` de más, karaoke corrido.

**A6 — Fin del documento → ▶ queda "reproduciendo" mudo para siempre (MSE).**
`mse-player.ts:337-344,392-402` + `PlayerBar.tsx:257-261,456-458`. Tras el último `endCallback` nadie llama `fullStop()`; en MSE `_hasCurrent` sigue true y `getCurrentPositionMs() > 0` → `handlePlayPause` hace `resume()` sobre un stream drenado sin `endOfStream()` → `isPlaying=true` sin audio y sin camino de recarga (`_endFired` bloquea re-detección). El clásico sí limpia en `ended` (`player.ts:99-104`); el MSE rompe ese contrato.

### Auto-sync

**A7 ✅ — CORS roto en dev: `credentials: 'include'` contra `Access-Control-Allow-Origin: '*'` — causa directa de los ERR_FAILED de QA.**
`sync-client.ts:157-263` (4 llamadas) + `worker/src/index.ts:16-21`. En dev todo `/sync/me` va cross-origin al worker; requests credenciados con ACAO `*` sin `Allow-Credentials` los aborta el navegador. El sync por identidad es 100% inoperante e intesteable en dev. (En prod no aplica: same-origin vía `/api`.) Además, aun arreglando CORS, en dev no llega `X-Verified-Email` y `DEV_FAKE_EMAIL` no está definido en ningún `[vars]` → 401 silencioso (worker/src/index.ts:273-280).

**A8 ✅ — El push "crítico" al ocultar/cerrar la pestaña usa fetch sin `keepalive` → el navegador lo mata a media petición.**
`auto-sync.ts:140-144` + `sync-client.ts:157-162`. `flushPush()` corre en `visibilitychange→hidden`/`pagehide`, justo cuando el fetch normal se aborta → el push del progreso final es el que muere (más ERR_FAILED en ráfaga al alternar pestañas). Fix natural: `keepalive: true` (el cap de 64KB cabe) o `sendBeacon`.

**A9 — Biblioteca grande revienta el cap de 64KB → 413 en cada push, ignorado a propósito: sync muerto en silencio para siempre.**
`auto-sync.ts:29-33` + `worker/src/index.ts:294-312` + `epub-utils.ts:215-225`. El snapshot incluye `coverDataUrl` (8–25KB por portada en base64); con ~3–7 libros con portada supera 64KB → 413 → descartado sin log, sin degradación (p.ej. sin portadas), sin pre-check de tamaño y sin estado en SyncPanel. El pull sí funciona, agravando la ilusión de que "se sincroniza solo".

**A10 ✅ — Sin cola, sin reintento, sin backoff: un fallo de red descarta el snapshot.**
`auto-sync.ts:25-53`. El fallo no re-agenda nada ni hay listener de `online`; el siguiente intento solo ocurre si el store cambia. Leer el último párrafo y cerrar la laptop = ese progreso jamás sube. Agravantes: el flag `pushing` hace que el flush de cierre se descarte si había push en vuelo (`if (pushing) return`, sin encolar), y el debounce de 20s se resetea con cada párrafo (sin maxWait) → en lectura continua el push periódico puede no dispararse nunca.

**A11 — PUT de snapshot completo sin versión/precondición → lost update entre dispositivos.**
`worker/src/index.ts:306-321` (overwrite ciego de R2) + `auto-sync.ts:29-30`. El merge por-libro solo corre en el pull inicial. B, que arrancó antes del push de A, pisa en la nube el progreso del libro X de A al pushear su libro Y. Dos tabs del mismo navegador producen el mismo flip-flop (zustand persist no sincroniza entre tabs). Falta pull-antes-de-push o If-Match/ETag en el worker.

### Lectura (auto-scroll / migración)

**A12 ✅ — El scroll programático se auto-clasifica como scroll de usuario → despegue espontáneo y bucle del pill.**
`ReaderView.tsx:81-103`. `PROGRAMMATIC_SCROLL_MS=800` es fijo pero `behavior:'smooth'` no tiene duración acotada; los eventos tardíos caen en la rama "usuario" y evalúan `setDetached`. En capítulos virtualizados el destino es estimado (`paragraphIndex * 90px`) → el párrafo activo puede quedar fuera de pantalla → pill "Volver a la lectura" espontáneo; tocarlo repite el mismo scroll estimado → bucle sin salida si está en pausa.

**A13 — El despegue mide visibilidad de PÁRRAFO pero el seguimiento es por PALABRA: dentro de un párrafo gigante no hay escape.**
`ReaderView.tsx:62-71` vs `133-149`. En el caso objetivo de la feature (párrafo más alto que el viewport), scrollear dentro del párrafo nunca activa `detached` (el párrafo sigue "visible") y cada tick de `wordIndex` regresa el scroll a la banda del 40% → tirón contra el usuario varias veces por segundo.

**A14 ✅ — La migración IDB marca "migrado" aunque la copia fallara a medias → libros varados para siempre.**
`rebrand-migration.ts:40-71`. El `catch` de `copyIdbStore` pensado para "DB vieja inexistente" también traga QuotaExceeded/cierres a media copia; `migrateIdbToFolio` fija el flag igual → nunca se reintenta. Como localStorage sí migró, la biblioteca lista los libros pero los contenidos quedan en la DB vieja: libros que no abren, sin error. (Relevante para la tester del PDF / usuarios beta pre-rebrand.)

---

## MEDIA

### Reproducción / PlayerBar

- **M1 — Cambio de voz/velocidad a media párrafo puede SALTAR los chunks restantes.** `PlayerBar.tsx:433-467`: la rama de avance del `endCallback` no valida generación — si el pre-encolado no alcanzó a entrar antes del bump, en vez de re-arrancar el párrafo con la voz nueva hace `nextParagraph`. Mismo evento, dos resultados según una carrera de red. (En MSE, además no hay forma de descartar chunks ya anexados con la voz vieja: suenan varios segundos hasta la frontera — `PlayerBar.tsx:381-391,433-444`.)
- **M2 — `skipToNextAfterError` usa `voiceId/speed` del closure de MONTAJE.** `PlayerBar.tsx:49-67,472` (deps `[doc]`): tras un error, el libro continúa indefinidamente con la voz/velocidad viejas bajo generación válida — nada lo corrige jamás. Compárese con el camino sano que usa `s2.voiceId/s2.speed` del store (línea 389).
- **M3 — Handlers de Media Session con closures stale y sin gate de `isBuffering`.** `PlayerBar.tsx:327-349`: deps `[doc, isPlaying, chapterIndex, paragraphIndex]` sin `voiceId/speed/generationId`. Desde la pantalla de bloqueo: next con voz vieja, play muerto tras cambiar voz en pausa, y navegación durante buffering que dispara los dobles arranques de A1.
- **M4 — Resume ignora la generación.** `PlayerBar.tsx:249-261`: pausa → cambio de voz → ▶ reanuda el audio de la voz vieja hasta la frontera del chunk (y puede caer en M1).

### Motor MSE

- **M5 — Recuperación de QuotaExceeded: deadlock y livelock.** `mse-player.ts:222-264`: si `evictPlayed` no inicia operación (poco reproducido o `remove` lanza), el append pendiente queda huérfano sin `updateend` que lo destrabe → "playing" mudo sin recuperación (con `pending>0` ambas detecciones de fin quedan bloqueadas). En pausa: ciclo remove/append infinito quemando CPU.
- **M6 — `segments` y el SourceBuffer crecen sin límite en el camino feliz.** `mse-player.ts:266-277`: no hay poda; un libro escuchado de corrido acumula todos los `WordTiming[]` y el audio completo hasta chocar con la quota, en vez de evictar proactivo.
- **M7 — `updateend`/`error` del SourceBuffer sin guard de generación.** `mse-player.ts:172-175,255-283`: un `updateend` rezagado del stream viejo (abort por detach) puede consumir `pending.shift()` del stream nuevo y empujar un segmento fantasma → posición/karaoke corruptos desde el arranque del stream.

### Auto-sync / worker

- **M8 — LWW con reloj del CLIENTE.** `library-store.ts:73,88-90`: un dispositivo con reloj adelantado pisa progreso real más nuevo (retroceso silencioso); el reemplazo wholesale además puede perder `bookPushed` → re-subida de hasta 8MB.
- **M9 — Los libros borrados resucitan y su contenido queda huérfano en R2.** `library-store.ts:62-64,84-86`: sin tombstones ni DELETE en el worker; cualquier dispositivo que aún tenga el libro lo re-pushea y el pull lo resucita. El objeto `book/{id}` (hasta 8MB) queda en R2 para siempre.
- **M10 — Docs de deploy contradicen la arquitectura real.** `DEPLOYMENT.md:24-27,132-135,238` + `README.md:115`: instruyen crear bucket `folio-tts-cache` (nada lo usa; ambos wrangler.toml ligan `speechify-tts-cache` a propósito) y poner `VITE_WORKER_URL` a workers.dev — con eso el sync por identidad muere en 401 silencioso (necesita el proxy same-origin `/api`). Quien siga la guía rompe producción sin síntoma.
- **M11 — Email sin sanitizar en la llave R2 + `X-Verified-Email` como única verdad.** `worker/src/index.ts:274-294`: un "email" con `/` escribe fuera de su prefijo. Hoy mitigado (Access no emite emails así y `workers_dev=false`), pero es la única línea de defensa; si alguien re-publica el worker standalone, cualquier cliente lee/escribe la biblioteca de cualquier usuario. Falta defensa en profundidad (secreto compartido Function→worker).

### Lectura / offline / migración

- **M12 — El auto-avance de capítulo pisa el modo despegado.** `ReaderView.tsx:152-161`: `chapterIndex` cambia por gapless → `scrollTop=0` + `setDetached(false)` incondicional: teletransporta al usuario que leía despegado en otra parte. No distingue navegación explícita de auto-avance.
- **M13 — Gesto del usuario DENTRO de la ventana de 800 ms se descarta.** `ReaderView.tsx:81-84`: inverso de A12 — con reproducción activa hay ventanas repetidas donde el usuario "no puede" scrollear (el siguiente tick lo regresa). Un timestamp único no clasifica scrolls superpuestos.
- **M14 — Top-level await de la migración bloquea el primer render y carga todo el cache de audio en memoria.** `main.tsx:18` + `rebrand-migration.ts:46-49`: `entries()` materializa potencialmente cientos de MB de MP3 (pantalla blanca, riesgo de jetsam en iOS); si `indexedDB.open` se cuelga (bug conocido de Safari), la app no renderiza nunca — sin `Promise.race` con tope como el que sí tiene epub-utils.
- **M15 — "✓ listo sin conexión" puede ser falso, y el fallback de evicción borra TODO.** `offline-download.ts:108` + `indexeddb-cache.ts:39-45,82-86`: `progress.done++` cuenta el fetch, no la persistencia — bajo presión de quota la evicción LRU puede borrar chunks del mismo capítulo recién bajado y el botón marca "done" igual. Y si la evicción falla, el catch hace `clear()` del cache completo (todas las descargas de todos los libros), en silencio.
- **M16 — Sin dedupe de fetches TTS en vuelo.** `offline-download.ts:97` + tts-client: descargar el capítulo que se está escuchando duplica POSTs al mismo chunk (descarga×2 + queueUpcoming + prefetch) → concurrencia efectiva 3-4 contra un Edge TTS frágil → más 429.

---

## BAJA

- **B1** `PlayerBar.tsx:46-55,132` — `consecutiveSkipsRef` no se resetea en navegación manual/cambio de gen: tras 3 skips, cada ▶ sobre un tramo malo pausa en seco sin avanzar.
- **B2** `playback-store.ts:97-99` — `nextParagraph` sin guard de `chapter` undefined con índices restaurados fuera de rango (libro re-extraído con menos capítulos) → TypeError en el set del store; `seekToParagraph` no clampa (`Library.tsx:53`).
- **B3** `mse-player.ts:61,392-402` — `END_EPS_MS` trunca hasta 120 ms audibles del final de párrafo en el camino endCallback.
- **B4** `mse-player.ts:337-344` — `getCurrentPositionMs()===0` con stream cargándose se malinterpreta como "nada cargado" → doble arranque con pausa+play rápidos.
- **B5** `auto-sync.ts:127-144` — suscripción y listeners globales sin desregistro; `flushPush` incondicional (PUT idéntico en cada cambio de pestaña); el pull inicial y cada `markBookPushed` disparan pushes derivados (amplificador de ráfagas).
- **B6** `polyfills.ts:33-49` — el shim de asyncIterator no libera el lock del reader al terminar la iteración normal (divergencia de spec, latente).
- **B7** `chunker.ts:141-146` — corte duro sin espacios parte una palabra → `wordOffset` +1 → seguimiento por palabra muerto el resto del párrafo (URLs/tablas).
- **B8** `offline-download.ts:97` — "Cancelar" no aborta los fetches en vuelo (señal solo entre chunks).
- **B9** `UpdateToast.tsx:13-17` — toast sin botón de cierre (overlay permanente), recarga inmediata que pierde la posición fina (persistencia a granularidad de párrafo), y botón muerto sin feedback si `updateFn` quedó null.
- **B10** `functions/api/[[path]].ts:81` — `exp` del JWT opcional en la validación (fail-open); Access siempre lo emite, pero debería ser fail-closed.
- **B11** `epub-utils.ts:24-29` — el timeout de `book.ready` no llama `book.destroy()` ni limpia el `setTimeout` tras éxito.
- **B12** `tts-client.ts:111` — el guard de audio "vacío o truncado" solo detecta 0 bytes; un MP3 truncado se cachea 30 días (la purga solo cura 0-bytes).
- **B13** `.gitignore` — falta `.wrangler/` explícito; `tsconfig.tsbuildinfo` trackeado (ruido en cada diff).
- **B14** Limpieza pendiente de infra (ya en el handoff): borrar el worker viejo `speechify-tts` del dashboard (verificado: `workers_dev=false` desde antes y sin `/sync/me` en su código, así que NO está expuesto — es limpieza, no incidente) y el plan del bucket `speechify-tts-cache`.

---

## Verificados SIN hallazgo (para no re-auditar)

- Rebranding de llaves: cobertura completa (3 llaves localStorage + 2 DBs IDB); no queda ninguna llave `speechify-*` en código vivo.
- `updatePositionState` neutraliza NaN/negativos; seek por click y drawer de capítulos bumpean generación correctamente vía `seekToParagraph`; `prefetchNext` valida gen por iteración; skip de párrafos vacíos no cicla en fin de documento.
- MSE: la eviction no desplaza la línea de tiempo (modo sequence), `appendBuffer` copia el buffer, `sourceopen` bien guardado por generación, `objectUrl` se revoca.
- `visibilitychange`: un solo listener en todo src/ (auto-sync); sin acumulación.
- Pages Function: borra `X-Verified-Email` del cliente antes de re-poner el verificado; `/sync/me` no colisiona con `SYNC_CODE_RE`.
- Worker `folio-tts`: `workers_dev=false` + `preview_urls=false` (verificado también en el commit base para el worker viejo).
- chunker con 0 chunks: los 4 consumidores lo manejan.

## Orden de ataque sugerido

1. **R1 completo** (arregla A1, A2, A3, M4 y parte de M1-M3 de un golpe): bumpear generación en toda navegación y en `closeReader`, invalidar `chainRef` con token por invocación de `queueUpcoming`, y anular callbacks en `destroy()`.
2. **A4 + A5 + A6** (motor MSE): desregistrar el handler de error antes del teardown (patrón del clásico), `endOnStall` con chequeo de posición + conocimiento de fetches en vuelo, y limpiar `_hasCurrent` al fin natural.
3. **A12 + A13 + M12 + M13** (auto-scroll): clasificar scroll por posición destino (no por timer), despegue por palabra visible (no párrafo), y no resetear detached en auto-avance.
4. **A14 + M14** (migración): no marcar el flag si la copia falló; timeout + copia incremental.
5. **Auto-sync (A7–A11, M8, M9)**: es medio subsistema — considerar sesión propia: keepalive/sendBeacon, cola con reintento+online, snapshot sin portadas (o pre-check de tamaño), y merge server-side o If-Match.
6. Medios/bajos restantes según roce con los síntomas reales.

**Pendiente clave: la lista de síntomas concretos de Ernesto** (el handoff pedía capturarla al arrancar; esta auditoría se hizo sin ella). Candidatos por dispositivo: iPhone (clásico) → A1/A2/A3/M1-M4; Android Brave (MSE) → A4/A5/A6/M5-M7, y A5 explica muerte en background con pantalla apagada. Antes de diagnosticar cualquier síntoma: confirmar versión desplegada en el dispositivo (el lag del SW ya causó 3 falsos negativos).
