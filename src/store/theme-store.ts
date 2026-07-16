import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';
/** Acentos propuestos en el mockup de Claude Design (Folio Rediseño v2). */
export type Accent = 'ambar' | 'violeta' | 'teal';

export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: 'ambar', label: 'Ámbar', swatch: '#e8a33d' },
  { id: 'violeta', label: 'Violeta', swatch: '#a293f5' },
  { id: 'teal', label: 'Teal', swatch: '#5fc9ae' },
];

interface ThemeStore {
  theme: Theme;
  accent: Accent;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: Accent) => void;
}

/** Refleja tema y acento en el <html> (data-theme / data-accent). La base de
 *  global.css usa oscuro+ámbar por defecto; las variantes viven en
 *  [data-theme='light'] y [data-accent='violeta'|'teal']. */
function applyTheme(theme: Theme, accent: Accent) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
  }
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      accent: 'ambar',
      toggle: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(next, get().accent);
        set({ theme: next });
      },
      setTheme: (theme: Theme) => {
        applyTheme(theme, get().accent);
        set({ theme });
      },
      setAccent: (accent: Accent) => {
        applyTheme(get().theme, accent);
        set({ accent });
      },
    }),
    {
      name: 'folio-theme',
      // Al rehidratar desde localStorage, aplica tema y acento guardados al DOM.
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.theme ?? 'dark', state?.accent ?? 'ambar');
      },
    },
  ),
);
