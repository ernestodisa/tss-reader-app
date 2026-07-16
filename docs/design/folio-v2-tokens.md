# Folio v2 — tokens y especificación del rediseño (Claude Design)

Fuente: proyecto claude.ai/design "App design moderno y dinámico", archivo `Folio Rediseño v2.dc.html`.

## Marca
- Nombre app: **Folio** (subtítulo "audiolector"). Logo: cuadrito 30×30 radius 8 fondo `--accent`, letra "f" Newsreader italic 600 color `--accent-ink`.
- Título del documento/PWA: "Folio — audiolector".

## Tipografías (Google Fonts)
- `Newsreader` (serif, ital+opsz 6..72, wght 400..700) — títulos, texto del libro, iniciales de portada.
- `Instrument Sans` (400..700) — UI.
- Import: `https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..700;1,6..72,400..700&family=Instrument+Sans:wght@400..700&display=swap`

## Tokens CSS (variables en :root, tema por atributo `data-theme`)
Tema oscuro (default, "Modo noche"):
```
--bg:#151312; --bg2:#1e1b19; --bg3:#292522; --ink:#ece7e1; --muted:#8f877f;
--line:#2d2925; --accent:#e8a33d; --accent-ink:#201812;
```
Tema claro ("Modo papel"):
```
--bg:#f5f1ea; --bg2:#fffdf9; --bg3:#eae3d8; --ink:#241f19; --muted:#84796c;
--line:#e2dacc; --accent:#9a6200; --accent-ink:#fffaf0;
```
Transición de tema: `background 0.35s, color 0.35s`. Toggle en header: "Modo papel" ↔ "Modo noche", pill `--bg3` borde `--line`, hover borde `--accent`. Persistir en localStorage.

## Header global (ambas vistas)
- Padding 18px 36px, borde inferior `--line`. Izquierda: logo + "Folio" (Newsreader italic 24px 500) + "AUDIOLECTOR" (11px, tracking 0.18em, uppercase, `--muted`).
- Derecha: en lector, botón pill "Biblioteca" (borde `--line`, texto `--muted`, hover ink) + toggle de tema. En biblioteca solo el toggle.
- Botones pill: `border-radius:999px; padding:8px 16px; font-size:13px`.

## Biblioteca
- Contenedor: padding ~38px 130px (desktop; en móvil 22px), column gap 24.
- Encabezado: kicker "CONTINÚA ESCUCHANDO" (12px tracking 0.2em uppercase `--accent`) + H1 "Tu biblioteca" (Newsreader 500, 44px, tracking -0.01em). A la derecha stats `--muted` 14px: "N libros · Xh Ym escuchadas" (estimar con totalCharacters/15 seg).
- Dropzone: borde 1.5px dashed `color-mix(in oklab, var(--accent) 45%, transparent)`, fondo `color-mix(in oklab, var(--accent) 6%, var(--bg2))`, radius 16, padding 22px 30px, fila: círculo 44px `--accent` con "+", título Newsreader italic 20px "Arrastra un PDF o ePub", subtítulo muted 13px "se convierte en audiolibro al instante · portada y capítulos se extraen solos". Hover: borde `--accent`.
- Tarjeta de libro (fila, no card cuadrada): grid `52px 1fr 240px 40px`, gap 22, fondo `--bg2`, borde `--line`, radius 16, padding 16px 24px. Hover: borde `--accent` + translateY(-2px).
  - Portada: 52×70 radius 6; si hay coverDataUrl usar la imagen (object-fit cover); si no, gradiente `linear-gradient(150deg, color-mix(in oklab, var(--accent) 26%, var(--bg3)), var(--bg3))` con inicial del título en Newsreader italic 28px `--accent`.
  - Título Newsreader 22px 500; meta muted 13px (autor · EPUB/PDF · duración estimada).
  - Columna progreso: fila 12px con label ("38% · Cap. IV" o "Nuevo") y "Continuar ›" en `--accent` 600; barra 4px radius 2 fondo `--bg3`, fill `--accent` al % leído.
  - ✕ borrar: sin fondo, `--muted`, hover #e57373.
- Sync: card `--bg2` radius 16; botón fila con chevron ▸/▾ `--accent` + "Sincronizar entre dispositivos" + a la derecha "último: ..." muted. Abierto: texto explicativo muted 13px; fila con code chip (`ui-monospace`, tracking 0.12em, 15px, fondo `--bg3` borde `--line` radius 10 padding 10px 16px, color `--accent`) + pills "Generar", "Copiar" + spacer + "↑ Subir progreso" (pill sólida `--accent`) y "↓ Bajar progreso" (pill `--bg3`). Línea de estado 12px muted.

## Lector
- Layout: grid `250px 1fr`. Sidebar SIEMPRE visible en desktop (>900px): borde derecho `--line`, padding 24px 20px, título "CAPÍTULOS" (11px tracking 0.18em uppercase muted). Items: botones text-align left, radius 10, padding 10px 12px, 13.5px; activo: fondo `color-mix(in oklab, var(--accent) 14%, transparent)`, color `--accent` 600; inactivos `--muted`. En móvil (<900px) el sidebar se oculta y se abre como drawer (mantener toggle ☰).
- Header del capítulo: padding 20px 60px 16px, borde inferior. Kicker "CAPÍTULO N" (11px tracking 0.22em uppercase `--accent`) + título (Newsreader 20px 500). Derecha: progreso 12px muted ("37% · Cap. 4/32 · párr. 2/14"), botón bookmark pill ("☆ Marcar" / "★ Marcado" — marcado: fondo `color-mix(...16%...)`, borde y texto `--accent` 600), botón "Notas · N" pill, botón "Exportar MP3" pill `--bg3` min-width 150 — durante export el fondo es un gradiente de progreso `linear-gradient(to right, color-mix(in oklab, var(--accent) 30%, var(--bg3)) P%, var(--bg3) P%)` con borde `--accent` y label "Exportando… P%".
- Contenido: scroll, padding 36px 100px 190px (dejar espacio al player flotante), columna max-width 680 centrada, gap 26.
  - Párrafos: Newsreader 22px, line-height 1.9. No activos: opacity 0.35, cursor pointer, hover opacity 0.6.
  - Párrafo activo: contenedor con `border-left:3px solid var(--accent); padding-left:22px; margin-left:-25px;` line-height 1.95.
  - Hint al final: "toca un párrafo para saltar ahí · la lectura continúa sola" (12px muted centrado).
- Karaoke modo **Barrido**: palabras ya leídas `color:var(--accent)`; palabra actual `color:var(--accent); box-shadow:inset 0 -2px var(--accent);` (subrayado). Spans con `border-radius:4px; transition:all 0.18s;`.
- Panel Notas (slide-over): absolute derecha, width 340, fondo `--bg2`, borde izq `--line`, sombra `-20px 0 50px rgba(0,0,0,0.3)`, padding 24. Título "Marcadores y notas" Newsreader 20px + ✕. Sección "MARCADORES": tarjetas botón `--bg3` radius 12 con "★ Capítulo X" (11px `--accent` 600) + excerpt Newsreader 14px muted; click navega. Sección "NOTAS" con acción "+ Nota en posición actual" (12px `--accent` 600); tarjetas con capítulo, excerpt en italic entre comillas y texto de la nota (13.5px).

## Player flotante (píldora)
- Absolute bottom 24, centrado, width ~920 (max-width calc(100% - 48px)), fondo `color-mix(in oklab, var(--bg2) 88%, transparent)` + `backdrop-filter:blur(14px)`, borde `--line`, radius 999, sombra `0 18px 50px rgba(0,0,0,0.4)`, padding 12px 20px, fila gap 14.
- Cluster transporte: "Cap −" pill 34px alto 11.5px; ⏮ circular 40px borde `--line`; PLAY circular 54px fondo `--accent` color `--accent-ink` 18px con sombra `0 6px 18px color-mix(in oklab, var(--accent) 45%, transparent)`, hover scale(1.05), label ❚❚/▶; ⏭ 40px; "Cap +".
- Waveform: 10 barras 3px (alturas 14,22,10,26,18,28,12,24,16,20), radius 2, `--accent`, `@keyframes wave { from{transform:scaleY(0.25)} to{transform:scaleY(1)} }`, `animation: wave 0.9s ease-in-out calc(i*0.09s) infinite alternate`, pausada+opacity 0.35 si no está sonando.
- Selector de voz: pill `--bg3` con puntito 7px `--accent` + nombre de voz 600 + "Motor ▾" muted 11px. Abre popover: absolute bottom ~104px centrado, width 560, fondo `--bg2` borde `--line` radius 18, sombra `0 24px 60px rgba(0,0,0,0.45)`, padding 20px 22px, columnas por motor ("EDGE TTS · GRATIS", "ELEVENLABS", "OPENAI" — solo los enabled de /engines; edge siempre). Voces: botones full-width radius 10 padding 8px 12px 13px con nombre + lang 11px; seleccionada: fondo `color-mix(...16%...)` borde+texto `--accent` 600.
- Velocidad: separador borde izq `--line` padding-left 14; botones − / + circulares 26px `--bg3`; label central 13px 600 min-width 38 ("1×", "1.25×"...; formato sin ceros colgantes).
- Volumen: separador igual; "vol" 12px muted + `input[type=range]` width 80 con `accent-color: var(--accent)`.

## Móvil (<900px)
- Biblioteca: padding 22px; H1 30px; tarjetas más compactas (portada 42×56, título 17px, % a la derecha de la barra).
- Lector: sin sidebar (drawer); header compacto "‹ Biblioteca" + progreso corto "Cap. N / M" + ★; player píldora bottom con ⏮ 36, play 48, ⏭ 36, waveform, pill velocidad. Ocultar Cap−/Cap+/voz/vol en la píldora en pantallas angostas (la voz se cambia desde un botón secundario o queda accesible >600px).

## Notas de implementación
- El mockup usa datos ficticios (Don Quijote): implementar contra los stores/datos reales existentes.
- Accent alternativos del mockup (Violeta #a293f5, Teal #5fc9ae) NO se implementan por ahora; solo Ámbar.
- Waveform es decorativa (no espectro real).
