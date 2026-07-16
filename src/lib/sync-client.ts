import type { LibraryEntry } from '../store/library-store';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:8787';

export interface SyncPayload {
  books: LibraryEntry[];
  syncedAt: number;
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
