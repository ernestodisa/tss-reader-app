import { create } from 'zustand';

// Estado visible del auto-sync por identidad (A9/A10): última sincronización OK,
// si hay un push pendiente, y el último error con su causa. Vive en un store
// SEPARADO de library-store a propósito: auto-sync se suscribe a library-store y
// agenda un push ante CUALQUIER cambio, así que meter el estado del sync ahí
// crearía un bucle de auto-disparo. Aquí no se persiste: es efímero de sesión.

export type SyncPhase = 'idle' | 'pending' | 'ok' | 'error';

interface SyncStatusStore {
  phase: SyncPhase;
  /** Momento (Date.now local) de la última sincronización exitosa. */
  lastSyncAt: number | null;
  /** Mensaje del último error, o null si el último intento fue bien. */
  error: string | null;
  markPending: () => void;
  markOk: () => void;
  markError: (message: string) => void;
}

export const useSyncStatus = create<SyncStatusStore>((set) => ({
  phase: 'idle',
  lastSyncAt: null,
  error: null,
  markPending: () => set((s) => (s.phase === 'pending' ? s : { ...s, phase: 'pending' })),
  markOk: () => set({ phase: 'ok', lastSyncAt: Date.now(), error: null }),
  markError: (message) => set({ phase: 'error', error: message }),
}));
