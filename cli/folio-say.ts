/**
 * folio-say — lee en voz alta la selección de texto usando el backend TTS de Folio.
 *
 * Se invoca desde un Quick Action de Automator ("Leer con Folio") que manda el
 * texto seleccionado por STDIN, o a mano con el texto como argumentos.
 *
 * Decisiones de diseño que conviene no perder:
 *
 * - El chunker es el REAL del repo (src/agents/chunker.ts). Nada de reimplementar
 *   el corte de oraciones aquí: el chunker ya carga las lecciones caras (corte
 *   lossless, no partir palabras, párrafos sin contenido pronunciable → 0 chunks).
 *   Como los imports del repo no llevan extensión, el type-stripping nativo de
 *   Node no los resuelve; por eso este archivo se bundlea con esbuild a
 *   dist/folio-say.mjs y el wrapper ejecuta el bundle.
 *
 * - MISMO atajo = play/stop. El estado vive en un pidfile: si ya hay una
 *   instancia sonando, la nueva la mata y sale. Sin esto haría falta un segundo
 *   atajo para callar la voz, que es justo lo que uno necesita con prisa.
 *
 * - El texto del usuario NUNCA toca un shell: viaja en el body HTTP y en archivos
 *   temporales con nombres fijos generados aquí (chunk-N.mp3).
 */

import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { chunkParagraph } from '../src/agents/chunker';
import type { TTSChunk } from '../src/types';

// ── Rutas y constantes ──────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.config', 'folio-say');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const STATE_DIR = join(homedir(), '.cache', 'folio-say');
const PID_PATH = join(STATE_DIR, 'folio-say.pid');
const AUDIO_PID_PATH = join(STATE_DIR, 'afplay.pid');

const DEFAULT_BASE_URL = 'https://folio.thestandardcurve.com/api';
const DEFAULT_SPEED = 1.0;
const MAX_CHUNK_CHARS = 250; // mismo tope que usa la app web

// Binarios del sistema por ruta ABSOLUTA. Automator/launchd arrancan con un PATH
// mínimo que además puede incluir "." (el default de bash sin entorno es
// "/usr/gnu/bin:/usr/local/bin:/bin:/usr/bin:."): buscar "ps" o "afplay" por PATH
// ahí es a la vez frágil y secuestrable desde el directorio de trabajo.
const PS_BIN = '/bin/ps';
const AFPLAY_BIN = '/usr/bin/afplay';

// Marcas para reconocer NUESTROS procesos en la línea de comando de `ps`
// (ver processMatches). El bundle vive en cli/dist/ y los temporales son los
// únicos archivos con este prefijo en la máquina.
const CHUNK_MARK = join(STATE_DIR, 'chunk-');
const BUNDLE_MARK = 'folio-say.mjs';

/** Alias cortos → voiceId completo de Edge (los 4 que expone el worker). */
const VOICE_ALIASES: Record<string, string> = {
  dalia: 'es-MX-DaliaNeural',
  jorge: 'es-MX-JorgeNeural',
  aria: 'en-US-AriaNeural',
  guy: 'en-US-GuyNeural',
};

interface Config {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  voice?: string;
  speed?: number;
}

/** Error "de usuario": se imprime como mensaje limpio, sin traza. */
class UserError extends Error {}

// ── Estado del proceso (para los handlers de señal) ─────────────────────

let audioChild: ReturnType<typeof spawn> | null = null;
let ownsPidfile = false;
let stopping = false;
const abortNetwork = new AbortController();

// ── Utilidades ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ¿El pid sigue vivo Y es REALMENTE un proceso nuestro? Se compara contra la
 * línea de comando COMPLETA, no contra el nombre del ejecutable: los pid se
 * reciclan y un pidfile huérfano (que solo sobrevive a un SIGKILL o a un crash)
 * podía apuntar a cualquier otro `node` de la máquina —un dev server, por
 * ejemplo— y nos lo llevábamos por delante. Las marcas que se buscan son rutas
 * que solo aparecen en los procesos que lanza este CLI.
 *
 * `-ww` va por seguridad: ps recorta la línea al ancho del terminal cuando su
 * salida ES un tty (aquí es un pipe, así que hoy no recortaría), y la marca vive
 * al final de una ruta larga. `ps -p <pid>` solo recibe un número, jamás texto
 * del usuario.
 */
function processMatches(pid: number, marca: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const cmd = execFileSync(PS_BIN, ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return cmd.includes(marca);
  } catch {
    // ps sale con código 1 cuando el pid no existe → proceso muerto.
    return false;
  }
}

function readPid(path: string): number | null {
  try {
    const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function removeQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ya no estaba */
  }
}

/** Borra los mp3 temporales (nombres fijos generados por el CLI). */
function removeTempAudio(): void {
  try {
    for (const name of readdirSync(STATE_DIR)) {
      if (/^chunk-\d+\.mp3$/.test(name)) removeQuiet(join(STATE_DIR, name));
    }
  } catch {
    /* el directorio puede no existir todavía */
  }
}

/**
 * Limpieza al salir. TODO el estado de ~/.cache/folio-say es COMPARTIDO entre
 * instancias, así que solo lo toca la que se adjudicó el turno (`ownsPidfile`).
 * Antes se borraba siempre y un `folio-say --help` o `--dry-run` lanzado mientras
 * otra instancia leía se llevaba por delante su afplay.pid — o sea, el único
 * rastro que permite callar un afplay huérfano — y sus mp3 temporales. El camino
 * de `--stop` no depende de esto: stopRunning() hace su propia limpieza.
 */
function cleanup(): void {
  if (audioChild) {
    try {
      audioChild.kill('SIGKILL');
    } catch {
      /* ya murió */
    }
    audioChild = null;
  }
  if (!ownsPidfile) return;
  removeQuiet(AUDIO_PID_PATH);
  if (readPid(PID_PATH) === process.pid) removeQuiet(PID_PATH);
  removeTempAudio();
}

// ── Configuración ───────────────────────────────────────────────────────

/**
 * Solo http/https. La URL sale de un archivo editable a mano y de --base; un
 * typo ("localhost:8787" sin esquema) reventaba dentro de fetch con una traza de
 * Node en vez del mensaje limpio que promete el CLI.
 */
function normalizeBaseUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(value)) {
    throw new UserError(`URL base inválida: "${input}" (tiene que empezar con http:// o https://)`);
  }
  return value;
}

/**
 * El config.json se edita a mano (el README lo permite explícitamente), así que
 * nada de confiar en los tipos: un baseUrl numérico o un secret con salto de
 * línea terminaban en traza de Node — el segundo, además, es un valor de header
 * inválido que fetch rechaza a media lectura en vez de al arrancar.
 */
function sanitizeConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('no es un objeto');
  const obj = raw as Record<string, unknown>;

  const str = (key: string): string | undefined => {
    const value = obj[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new Error(`"${key}" debería ser texto entre comillas`);
    const trimmed = value.trim();
    // Control chars escapados: un secret con CR/LF es un valor de header ilegal.
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`"${key}" trae caracteres de control`);
    return trimmed || undefined;
  };

  const speed = obj.speed;
  if (speed !== undefined && speed !== null && typeof speed !== 'number' && typeof speed !== 'string') {
    throw new Error('"speed" debería ser un número');
  }

  return {
    baseUrl: normalizeBaseUrl(str('baseUrl') ?? DEFAULT_BASE_URL),
    clientId: str('clientId'),
    clientSecret: str('clientSecret'),
    voice: str('voice'),
    speed: speed === undefined || speed === null ? undefined : parseSpeed(speed),
  };
}

function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return sanitizeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    throw new UserError(
      `la configuración en ${CONFIG_PATH} está corrupta (${
        err instanceof Error ? err.message : 'error desconocido'
      }). Corre: folio-say --setup`,
    );
  }
}

function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // mode en writeFileSync solo aplica si el archivo NO existía; el chmod
  // explícito garantiza 600 también al reconfigurar (ahí van credenciales).
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

async function runSetup(): Promise<void> {
  // Sin terminal, readline se come las respuestas que llegan de golpe por el
  // pipe y el proceso muere en silencio SIN escribir nada — un fallo mudo que
  // parece "ya quedó configurado". Mejor decirlo de frente.
  if (!process.stdin.isTTY) {
    throw new UserError(
      '--setup necesita una terminal interactiva. Córrelo directamente en la ' +
        `terminal, o edita a mano ${CONFIG_PATH} (chmod 600).`,
    );
  }

  // Config corrupta: --setup es EL camino para arreglarla, así que aquí no puede
  // ser fatal. Antes heredaba el UserError de loadConfig ("corre folio-say
  // --setup") y dejaba al usuario en un callejón sin salida: --setup mandándote
  // a --setup.
  let previo: Config | null = null;
  try {
    previo = loadConfig();
  } catch (err) {
    console.error(
      `folio-say: no pude leer la configuración anterior (${
        err instanceof Error ? err.message : 'error desconocido'
      }).\nSe reescribe desde cero.\n`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Ctrl+D (o un stdin que se cierra) hace que readline rechace con AbortError.
  // Sin este envoltorio salía una traza de node:internal/readline en la cara del
  // usuario por cancelar un prompt, que es lo más normal del mundo.
  const preguntar = async (prompt: string): Promise<string> => {
    try {
      return await rl.question(prompt);
    } catch {
      throw new UserError('configuración cancelada, no se guardó nada');
    }
  };

  const ask = async (label: string, fallback: string): Promise<string> => {
    const answer = (await preguntar(`${label} [${fallback}]: `)).trim();
    return answer || fallback;
  };

  console.log('folio-say — configuración\n');
  console.log('Se guarda en ' + CONFIG_PATH + ' con permisos 600.\n');

  const baseUrl = normalizeBaseUrl(
    await ask(
      'URL base del backend (producción incluye /api; en dev local es http://localhost:8787)',
      previo?.baseUrl || DEFAULT_BASE_URL,
    ),
  );

  console.log(
    '\nProducción está detrás de Cloudflare Access. Para que el CLI entre sin\n' +
      'navegador hay que crear un *service token* en Zero Trust → Access →\n' +
      'Service Auth, y añadir una política "Service Auth" a la aplicación de\n' +
      'Folio que acepte ese token. Cloudflare muestra el Client ID y el Client\n' +
      'Secret UNA sola vez: cópialos ahí mismo.\n' +
      'Si vas a usar solo el worker local (sin Access), déjalos vacíos.\n',
  );

  const clientId = (
    await preguntar(`CF-Access-Client-Id (opcional)${previo?.clientId ? ' [enter = conservar]' : ''}: `)
  ).trim();
  const clientSecret = (
    await preguntar(
      `CF-Access-Client-Secret (opcional)${previo?.clientSecret ? ' [enter = conservar]' : ''}: `,
    )
  ).trim();

  const voiceRaw = await ask(
    '\nVoz por defecto (dalia | jorge | aria | guy)',
    previo?.voice ? shortVoiceName(previo.voice) : 'dalia',
  );
  const voice = resolveVoice(voiceRaw);

  const speedRaw = await ask('Velocidad por defecto', String(previo?.speed ?? DEFAULT_SPEED));
  const speed = parseSpeed(speedRaw);

  rl.close();

  const cfg: Config = {
    baseUrl,
    // Enter en blanco conserva la credencial anterior: reconfigurar la voz no
    // debería obligar a volver a pegar un token que Cloudflare ya no muestra.
    clientId: clientId || previo?.clientId || undefined,
    clientSecret: clientSecret || previo?.clientSecret || undefined,
    voice,
    speed,
  };
  saveConfig(cfg);

  console.log(`\nListo. Configuración guardada en ${CONFIG_PATH}`);
  console.log(`  baseUrl   : ${cfg.baseUrl}`);
  console.log(`  voz       : ${cfg.voice}`);
  console.log(`  velocidad : ${cfg.speed}`);
  console.log(
    `  auth      : ${cfg.clientId && cfg.clientSecret ? 'service token configurado' : 'sin credenciales (solo dev local)'}`,
  );
}

function shortVoiceName(voiceId: string): string {
  for (const [alias, full] of Object.entries(VOICE_ALIASES)) {
    if (full === voiceId) return alias;
  }
  return voiceId;
}

/** Acepta alias corto o voiceId completo (el chunker sabe decodificar ambos). */
function resolveVoice(input: string): string {
  const key = input.trim().toLowerCase();
  if (VOICE_ALIASES[key]) return VOICE_ALIASES[key];
  if (!input.trim()) return VOICE_ALIASES.dalia;
  return input.trim();
}

function parseSpeed(input: string | number): number {
  const value = typeof input === 'number' ? input : parseFloat(input);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UserError(`velocidad inválida: "${input}" (usa un número como 1.0, 1.25, 2)`);
  }
  // El worker acepta el rango que soporte el motor; fuera de [0.5, 3] Edge
  // devuelve audio inservible, así que se avisa y se recorta.
  if (value < 0.5 || value > 3) {
    console.error(`folio-say: velocidad ${value} fuera de rango, se ajusta al límite`);
    return Math.min(3, Math.max(0.5, value));
  }
  return value;
}

// ── Argumentos ──────────────────────────────────────────────────────────

interface Flags {
  voice?: string;
  speed?: string;
  base?: string;
  stop: boolean;
  setup: boolean;
  dryRun: boolean;
  help: boolean;
  words: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { stop: false, setup: false, dryRun: false, help: false, words: [] };
  const needsValue = new Set(['--voice', '--speed', '--base']);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Todo lo que sigue es texto, aunque empiece con guion.
      flags.words.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      flags.words.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);

    if (needsValue.has(name)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UserError(`falta el valor de ${name}`);
      }
      if (name === '--voice') flags.voice = value;
      else if (name === '--speed') flags.speed = value;
      else flags.base = value;
      continue;
    }

    switch (name) {
      case '--stop':
        flags.stop = true;
        break;
      case '--setup':
        flags.setup = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      case '--help':
        flags.help = true;
        break;
      default:
        throw new UserError(`opción desconocida: ${name} (corre folio-say --help)`);
    }
  }
  return flags;
}

const USAGE = `folio-say — lee texto en voz alta con el backend TTS de Folio.

USO
  folio-say [opciones] "texto a leer"
  pbpaste | folio-say
  folio-say --stop

  Invocado sin texto y con una lectura en curso, la detiene: el MISMO atajo de
  teclado sirve para reproducir y para callar.

OPCIONES
  --voice <voz>   dalia | jorge | aria | guy (o un voiceId completo de Edge)
  --speed <n>     velocidad de lectura, p. ej. 1.25 (rango 0.5–3)
  --base <url>    URL base del backend, solo para esta corrida
                  (dev local: http://localhost:8787)
  --stop          detiene la lectura en curso y sale
  --setup         configuración interactiva (backend, service token, voz, velocidad)
  --dry-run       imprime los chunks y los requests que haría, sin red ni audio
  --help          esta ayuda

CONFIGURACIÓN
  ~/.config/folio-say/config.json (chmod 600)
  Estado temporal en ~/.cache/folio-say/`;

// ── Toggle play/stop ────────────────────────────────────────────────────

/**
 * Mata la instancia en curso si la hay. Devuelve true si detuvo algo.
 *
 * Se mata primero el afplay y luego el node: al revés, el node moribundo podría
 * lanzar el siguiente chunk antes de procesar su propia señal. El pidfile de
 * afplay existe porque si el node muere de forma abrupta (SIGKILL, crash) su
 * handler no corre y el audio se quedaría sonando huérfano sin manera de callarlo.
 */
function stopRunning(): boolean {
  let detuvo = false;

  const audioPid = readPid(AUDIO_PID_PATH);
  if (audioPid !== null && processMatches(audioPid, CHUNK_MARK)) {
    try {
      process.kill(audioPid, 'SIGTERM');
      detuvo = true;
    } catch {
      /* murió entre el check y el kill */
    }
  }
  removeQuiet(AUDIO_PID_PATH);

  const pid = readPid(PID_PATH);
  if (pid !== null && pid !== process.pid && processMatches(pid, BUNDLE_MARK)) {
    try {
      process.kill(pid, 'SIGTERM');
      detuvo = true;
    } catch {
      /* ídem */
    }
  }
  // Pidfile huérfano (proceso muerto) o ya atendido: fuera en ambos casos, para
  // que la próxima invocación no crea que hay algo sonando.
  removeQuiet(PID_PATH);
  removeTempAudio();

  return detuvo;
}

function claimPidfile(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  ownsPidfile = true;
}

// ── Chunking ────────────────────────────────────────────────────────────

interface PlanItem {
  chunk: TTSChunk;
  paragraphIndex: number;
}

function buildPlan(text: string, voiceId: string, speed: number): PlanItem[] {
  // Un párrafo = bloque separado por línea en blanco. Es la misma unidad que usa
  // la app web y la que el chunker espera recibir.
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const plan: PlanItem[] = [];
  paragraphs.forEach((paragraphText, index) => {
    const result = chunkParagraph({
      paragraphId: `p${index}`,
      paragraphText,
      voiceId,
      speed,
      maxChunkChars: MAX_CHUNK_CHARS,
      strategy: 'sentence',
    });
    if (!result.success) {
      throw new UserError(`no se pudo dividir el párrafo ${index + 1}: ${result.error.message}`);
    }
    // Párrafos sin contenido pronunciable ("• • •", "***") devuelven 0 chunks:
    // se saltan en silencio, igual que en la app.
    for (const chunk of result.data.chunks) plan.push({ chunk, paragraphIndex: index });
  });

  return plan;
}

// ── Red ─────────────────────────────────────────────────────────────────

function ttsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/tts`;
}

function authHeaders(cfg: Config): Record<string, string> {
  // Los headers de Access solo se mandan si hay credenciales: el worker local
  // no las necesita y mandarlas vacías confunde el diagnóstico.
  if (!cfg.clientId || !cfg.clientSecret) return {};
  return {
    'CF-Access-Client-Id': cfg.clientId,
    'CF-Access-Client-Secret': cfg.clientSecret,
  };
}

function requestBody(chunk: TTSChunk): string {
  return JSON.stringify({
    text: chunk.text,
    voiceId: chunk.voiceId,
    engine: chunk.engine,
    speed: chunk.speed,
    format: 'mp3',
  });
}

/**
 * Un MP3 válido arranca con frame sync MPEG (0xFF 0xEx/0xFx) o con etiqueta ID3.
 * Lección del repo: Edge TTS responde a veces 200 con 0 bytes o con un cuerpo que
 * no es audio; reproducir eso deja un afplay mudo que "termina bien" y parece que
 * el CLI se saltó el párrafo. Barato de comprobar, así que se comprueba siempre.
 */
function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  const isId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
  const isMpegSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
  return isId3 || isMpegSync;
}

async function fetchChunkAudio(chunk: TTSChunk, cfg: Config): Promise<Buffer> {
  const url = ttsUrl(cfg.baseUrl);
  let rateRetries = 0; // 429 → hasta 3 reintentos
  let audioRetries = 0; // cuerpo no-MP3 → hasta 2
  let netRetries = 0; // fallo de red → 1

  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        signal: abortNetwork.signal,
        headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
        body: requestBody(chunk),
      });
    } catch (err) {
      if (abortNetwork.signal.aborted) throw new UserError('lectura cancelada');
      if (netRetries++ >= 1) {
        throw new UserError(
          `no se pudo contactar el backend (${url}): ${
            err instanceof Error ? err.message : 'error de red'
          }`,
        );
      }
      await sleep(700);
      continue;
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new UserError(
        'credenciales inválidas o sesión expirada. Revisa el service token de ' +
          'Cloudflare Access con: folio-say --setup',
      );
    }

    if (resp.status === 429) {
      const body = (await resp.json().catch(() => ({}))) as { retryAfterMs?: number };
      if (rateRetries++ >= 3) {
        throw new UserError('el backend sigue limitando las peticiones (429). Intenta más tarde.');
      }
      await sleep(typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 1000);
      continue;
    }

    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 200);
      throw new UserError(`el backend respondió HTTP ${resp.status}${detail ? `: ${detail}` : ''}`);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    if (!looksLikeMp3(buf)) {
      if (audioRetries++ >= 2) {
        throw new UserError(
          'el backend devolvió audio inválido varias veces seguidas (0 bytes o sin cabecera MP3).',
        );
      }
      await sleep(800);
      continue;
    }

    return buf;
  }
}

// ── Reproducción ────────────────────────────────────────────────────────

function playFile(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(AFPLAY_BIN, [path], { stdio: 'ignore' });
    audioChild = child;
    if (typeof child.pid === 'number') {
      // El pid en disco permite que un `--stop` calle el audio aunque este
      // proceso ya no pueda hacerlo (ver stopRunning).
      try {
        writeFileSync(AUDIO_PID_PATH, String(child.pid), { mode: 0o600 });
      } catch {
        /* no crítico */
      }
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      audioChild = null;
      removeQuiet(AUDIO_PID_PATH);
      if (err.code === 'ENOENT') {
        reject(new UserError('no se encontró `afplay` (folio-say solo corre en macOS)'));
      } else {
        reject(new UserError(`no se pudo reproducir el audio: ${err.message}`));
      }
    });

    child.on('exit', (code, signal) => {
      audioChild = null;
      removeQuiet(AUDIO_PID_PATH);
      if (signal) {
        // A nadie que mata el audio le interesa oír el párrafo SIGUIENTE. Marcar
        // `stopping` corta la lectura completa, no solo este chunk: así el stop
        // funciona aunque la señal solo alcance al afplay y no a este proceso.
        stopping = true;
        abortNetwork.abort();
        resolve();
      } else if (code === 0 || stopping) resolve();
      else reject(new UserError(`afplay terminó con código ${code}`));
    });
  });
}

// ── Dry run ─────────────────────────────────────────────────────────────

function printDryRun(plan: PlanItem[], cfg: Config): void {
  const headers = { 'Content-Type': 'application/json', ...authHeaders(cfg) };
  const headerList = Object.keys(headers)
    .map((k) => (k.startsWith('CF-Access') ? `${k}: ***` : `${k}: ${headers[k as keyof typeof headers]}`))
    .join(', ');

  const paragraphs = new Set(plan.map((p) => p.paragraphIndex)).size;
  console.log('folio-say — simulación (--dry-run: sin red, sin audio)\n');
  console.log(`  backend    : ${ttsUrl(cfg.baseUrl)}`);
  console.log(`  voz        : ${cfg.voice}`);
  console.log(`  velocidad  : ${cfg.speed}`);
  console.log(
    `  auth       : ${cfg.clientId && cfg.clientSecret ? 'CF-Access service token' : 'sin credenciales'}`,
  );
  console.log(`  párrafos   : ${paragraphs}`);
  console.log(`  chunks     : ${plan.length}\n`);

  plan.forEach((item, i) => {
    const { chunk } = item;
    console.log(
      `[${i + 1}/${plan.length}] ${chunk.paragraphId}#${chunk.chunkIndex} — ${chunk.text.length} chars, voz ${chunk.voiceId} (${chunk.engine}), speed ${chunk.speed}`,
    );
    console.log(`  texto : ${JSON.stringify(chunk.text)}`);
    console.log(`  POST  : ${ttsUrl(cfg.baseUrl)}`);
    console.log(`  head  : ${headerList}`);
    console.log(`  body  : ${requestBody(chunk)}`);
    console.log('');
  });
}

// ── Entrada de texto ────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  // Sin pipe (terminal interactiva) no hay nada que leer: no bloquear al usuario.
  if (process.stdin.isTTY) return '';
  const parts: Buffer[] = [];
  for await (const part of process.stdin) parts.push(Buffer.from(part));
  return Buffer.concat(parts).toString('utf8');
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  if (flags.setup) {
    await runSetup();
    return 0;
  }

  if (flags.stop) {
    console.error(stopRunning() ? 'folio-say: lectura detenida' : 'folio-say: no había nada sonando');
    return 0;
  }

  // Toggle: si ya hay una instancia sonando, esta invocación la calla y sale.
  // Se comprueba ANTES de leer stdin para que el atajo corte al instante y no se
  // quede esperando texto que ya no hace falta. --dry-run queda fuera: prometió
  // no tocar el audio, y callar la lectura en curso sería justo eso.
  if (!flags.dryRun) {
    const running = readPid(PID_PATH);
    if (running !== null && running !== process.pid && processMatches(running, BUNDLE_MARK)) {
      stopRunning();
      console.error('folio-say: lectura detenida');
      return 0;
    }
    if (running !== null) stopRunning(); // pidfile huérfano: limpiar y seguir
  }

  const fromArgs = flags.words.join(' ').trim();
  const text = fromArgs || (await readStdin()).trim();
  if (!text) {
    console.error('folio-say: no recibí texto.\n');
    console.error(USAGE);
    return 1;
  }

  // Config: obligatoria salvo que la corrida se apoye en --base (dev local) o
  // sea un --dry-run (que debe poder correrse en una máquina recién clonada).
  const stored = loadConfig();
  if (!stored && !flags.base && !flags.dryRun) {
    throw new UserError('no hay configuración todavía. Corre: folio-say --setup');
  }
  if (!stored && flags.dryRun) {
    console.error('folio-say: sin configuración, la simulación usa los valores por defecto\n');
  }

  const cfg: Config = {
    // stored.baseUrl ya viene normalizada por sanitizeConfig; --base no.
    baseUrl: flags.base ? normalizeBaseUrl(flags.base) : stored?.baseUrl || DEFAULT_BASE_URL,
    clientId: stored?.clientId,
    clientSecret: stored?.clientSecret,
    voice: resolveVoice(flags.voice || stored?.voice || 'dalia'),
    speed: flags.speed !== undefined ? parseSpeed(flags.speed) : parseSpeed(stored?.speed ?? DEFAULT_SPEED),
  };

  const plan = buildPlan(text, cfg.voice!, cfg.speed!);
  if (plan.length === 0) {
    console.error('folio-say: el texto no tiene nada pronunciable');
    return 0;
  }

  if (flags.dryRun) {
    printDryRun(plan, cfg);
    return 0;
  }

  claimPidfile(); // ya crea STATE_DIR con mode 0700

  /**
   * PREFETCH de un chunk: mientras suena el N ya se está bajando el N+1. Con una
   * sola descarga adelantada basta — el hueco que se quiere tapar es el de la
   * latencia del POST, y adelantar más solo calienta el rate-limit de Edge.
   */
  let pending: Promise<Buffer> | null = fetchChunkAudio(plan[0].chunk, cfg);
  // Un rechazo mientras nadie lo espera sería unhandledRejection y tumbaría el
  // proceso a media reproducción; este catch inerte solo marca la promesa como
  // atendida — el error se vuelve a lanzar en el `await` de su iteración.
  pending.catch(() => {});

  for (let i = 0; i < plan.length; i++) {
    if (stopping) break;
    const buf = await pending!;

    // Lanzar la descarga del siguiente ANTES de reproducir el actual: ahí está
    // todo el beneficio del prefetch.
    if (i + 1 < plan.length) {
      pending = fetchChunkAudio(plan[i + 1].chunk, cfg);
      pending.catch(() => {});
    } else {
      pending = null;
    }

    const file = join(STATE_DIR, `chunk-${i}.mp3`);
    writeFileSync(file, buf, { mode: 0o600 });
    process.stderr.write(`\rfolio-say: ${i + 1}/${plan.length}`);
    await playFile(file);
    removeQuiet(file);
  }

  process.stderr.write('\n');
  return 0;
}

// ── Arranque ────────────────────────────────────────────────────────────

function onSignal(): void {
  // El stop del toggle llega como SIGTERM: hay que matar TAMBIÉN el afplay hijo,
  // que no muere solo (no comparte grupo de proceso con nosotros).
  stopping = true;
  abortNetwork.abort();
  cleanup();
  process.exit(130);
}

process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((err) => {
    cleanup();
    if (err instanceof UserError) {
      console.error(`folio-say: ${err.message}`);
      process.exit(1);
    }
    console.error(`folio-say: error inesperado: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
