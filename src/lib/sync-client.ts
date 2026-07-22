import type { LibraryEntry, Tombstone } from '../store/library-store';
import type { ExtractedDoc } from '../types';

// A7: default a la ruta relativa `/api` (same-origin en dev vía proxy de Vite y
// en prod vía Pages Function). Solo se sobreescribe si se apunta a un worker
// externo explícito.
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '/api';

export interface SyncPayload {
  books: LibraryEntry[];
  /** Lápidas de libros borrados (M9). Opcional para compatibilidad con snapshots
   *  viejos y con el sync por-código. */
  tombstones?: Tombstone[];
  syncedAt: number;
}

/** Datos de control que el worker devuelve en las respuestas de /sync/me:
 *  `etag` para la precondición optimista (A11) y `serverNow` para el offset de
 *  reloj (M8). Ambos pueden faltar (respuestas 404 / snapshots viejos). */
export interface SyncMeMeta {
  etag: string | null;
  serverNow: number | null;
}

function readMeta(resp: Response): SyncMeMeta {
  const etag = resp.headers.get('ETag');
  const serverNowRaw = resp.headers.get('X-Server-Now');
  const serverNow = serverNowRaw != null ? Number(serverNowRaw) : null;
  return {
    etag: etag || null,
    serverNow: serverNow != null && Number.isFinite(serverNow) ? serverNow : null,
  };
}

// Nota: no reutilizamos AgentResult<T> de src/types/errors.ts porque su
// PipelineStep está cerrado a 'extract'|'chunk'|'tts'|'play' (archivo ajeno,
// no se toca aquí). SyncResult es el análogo local para este módulo.
export interface SyncError {
  code: string;
  message: string;
  recoverable: boolean;
}

export type SyncResult<T> =
  | { success: true; data: T }
  | { success: false; error: SyncError };

/** Genera un código legible (sin caracteres ambiguos) de 8 caracteres, ej. "K7XQ2M4P". */
export function generateSyncCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0, I/1, L
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export async function pushProgress(code: string, payload: SyncPayload): Promise<SyncResult<void>> {
  try {
    const resp = await fetch(`${WORKER_URL}/sync/${encodeURIComponent(code)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          code: 'sync_push_failed',
          message: body.error || `HTTP ${resp.status}`,
          recoverable: true,
        },
      };
    }
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

export async function pullProgress(code: string): Promise<SyncResult<SyncPayload>> {
  try {
    const resp = await fetch(`${WORKER_URL}/sync/${encodeURIComponent(code)}`, {
      method: 'GET',
    });
    if (resp.status === 404) {
      return {
        success: false,
        error: {
          code: 'not_found',
          message: 'No hay progreso guardado con ese código todavía.',
          recoverable: true,
        },
      };
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          code: 'sync_pull_failed',
          message: body.error || `HTTP ${resp.status}`,
          recoverable: true,
        },
      };
    }
    const data = (await resp.json()) as SyncPayload;
    return { success: true, data };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

// ── Sync de libros completos (contenido, no solo progreso) ───────────────
// El ExtractedDoc serializado se guarda bajo sync/{code}/book/{bookId} en R2.
// Así otro dispositivo puede bajar el libro sin re-importar el archivo.

export async function pushBook(
  code: string,
  bookId: string,
  doc: ExtractedDoc,
): Promise<SyncResult<void>> {
  try {
    const resp = await fetch(
      `${WORKER_URL}/sync/${encodeURIComponent(code)}/book/${encodeURIComponent(bookId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      },
    );
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          code: 'book_push_failed',
          message: body.error || `HTTP ${resp.status}`,
          recoverable: true,
        },
      };
    }
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

// ── Sync por IDENTIDAD (cuenta de Cloudflare Access) ─────────────────────
// Mismas formas de payload que el sync por código, pero contra las rutas
// /api/sync/me* del mismo origen. La auth es implícita: la cookie de Access
// viaja con `credentials: 'include'` y la Pages Function valida el JWT. No hay
// código ni header de usuario. En dev, WORKER_URL apunta al worker local y la
// ruta relativa /sync/me se resuelve ahí igual que las de arriba.

export interface PushMeOptions {
  /** ETag conocido del snapshot en la nube. Si se envía, el worker aplica la
   *  precondición If-Match y responde 412 si otro dispositivo escribió en medio
   *  (A11 → el llamador hace pull+merge+re-push). */
  ifMatch?: string;
  /** `keepalive: true` en el PUT del snapshot para que el navegador NO lo mate al
   *  ocultar/cerrar la pestaña (A8). Solo válido para el snapshot (≤64KB, el cap
   *  de keepalive); los pushes de libro (hasta 8MB) NO pueden usarlo. */
  keepalive?: boolean;
}

/** Progreso/biblioteca del usuario autenticado. 401 → sin sesión de Access; 412
 *  (con ifMatch) → `conflict`. Devuelve el etag y serverNow frescos. */
export async function pushProgressMe(
  payload: SyncPayload,
  options: PushMeOptions = {},
): Promise<SyncResult<SyncMeMeta>> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.ifMatch) headers['If-Match'] = options.ifMatch;
    const resp = await fetch(`${WORKER_URL}/sync/me`, {
      method: 'PUT',
      headers,
      credentials: 'include',
      keepalive: options.keepalive === true,
      body: JSON.stringify(payload),
    });
    if (resp.status === 401) {
      return {
        success: false,
        error: { code: 'no_autenticado', message: 'Sin sesión de Access.', recoverable: true },
      };
    }
    if (resp.status === 412) {
      // Otro dispositivo/tab escribió después de nuestro último etag: el
      // llamador debe pull+merge+re-push (convierte el lost-update en merge).
      return {
        success: false,
        error: { code: 'conflict', message: 'Conflicto de versión (etag).', recoverable: true },
      };
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: { code: 'sync_push_failed', message: body.error || `HTTP ${resp.status}`, recoverable: true },
      };
    }
    return { success: true, data: readMeta(resp) };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

export async function pullProgressMe(): Promise<SyncResult<SyncPayload & SyncMeMeta>> {
  try {
    const resp = await fetch(`${WORKER_URL}/sync/me`, {
      method: 'GET',
      credentials: 'include',
    });
    if (resp.status === 401) {
      return {
        success: false,
        error: { code: 'no_autenticado', message: 'Sin sesión de Access.', recoverable: true },
      };
    }
    if (resp.status === 404) {
      // Aún no hay nada guardado para esta identidad: biblioteca vacía en la nube.
      // Aun así puede traer X-Server-Now para calibrar el reloj.
      const meta = readMeta(resp);
      return { success: true, data: { books: [], tombstones: [], syncedAt: 0, ...meta } };
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: { code: 'sync_pull_failed', message: body.error || `HTTP ${resp.status}`, recoverable: true },
      };
    }
    const data = (await resp.json()) as SyncPayload;
    return { success: true, data: { ...data, ...readMeta(resp) } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

export async function pushBookMe(bookId: string, doc: ExtractedDoc): Promise<SyncResult<void>> {
  try {
    const resp = await fetch(`${WORKER_URL}/sync/me/book/${encodeURIComponent(bookId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(doc),
    });
    if (resp.status === 401) {
      return {
        success: false,
        error: { code: 'no_autenticado', message: 'Sin sesión de Access.', recoverable: true },
      };
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: { code: 'book_push_failed', message: body.error || `HTTP ${resp.status}`, recoverable: true },
      };
    }
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

export async function pullBookMe(bookId: string): Promise<SyncResult<ExtractedDoc>> {
  try {
    const resp = await fetch(`${WORKER_URL}/sync/me/book/${encodeURIComponent(bookId)}`, {
      credentials: 'include',
    });
    if (resp.status === 401) {
      return {
        success: false,
        error: { code: 'no_autenticado', message: 'Sin sesión de Access.', recoverable: true },
      };
    }
    if (resp.status === 404) {
      return {
        success: false,
        error: { code: 'not_found', message: 'Ese libro no está en la nube.', recoverable: true },
      };
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: { code: 'book_pull_failed', message: body.error || `HTTP ${resp.status}`, recoverable: true },
      };
    }
    const doc = (await resp.json()) as ExtractedDoc;
    return { success: true, data: doc };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}

export async function pullBook(code: string, bookId: string): Promise<SyncResult<ExtractedDoc>> {
  try {
    const resp = await fetch(
      `${WORKER_URL}/sync/${encodeURIComponent(code)}/book/${encodeURIComponent(bookId)}`,
    );
    if (resp.status === 404) {
      return {
        success: false,
        error: { code: 'not_found', message: 'Ese libro no está subido con este código.', recoverable: true },
      };
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return {
        success: false,
        error: {
          code: 'book_pull_failed',
          message: body.error || `HTTP ${resp.status}`,
          recoverable: true,
        },
      };
    }
    const doc = (await resp.json()) as ExtractedDoc;
    return { success: true, data: doc };
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'network error',
        recoverable: true,
      },
    };
  }
}
