import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';
/** Acentos propuestos en el mockup de Claude Design (Folio Rediseño v2). */
export type Accent = 'ambar' | 'violeta' | 'teal';

export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  // swatch se deriva del tema activo en tiempo de render (ver useAccentSwatch):
  // dark → tonos claros; light → tonos oscuros (contraste AA sobre bg).
  { id: 'ambar', label: 'Ámbar', swatch: '#e8a33d' },
  { id: 'violeta', label: 'Violeta', swatch: '#a293f5' },
  { id: 'teal', label: 'Teal', swatch: '#5fc9ae' },
];

/** swatch visible según el tema. En modo claro los acentos se oscurecen para
 *  mantener el contraste AA sobre --bg claro (los ACCENTS.swatch son del
 *  tema oscuro). Esto corrige el fallo de OD: swatches hardcodeados al dark.
 *  NO es un hook (no usa useState/useEffect) pese a no empezar con "use";
 *  se invoca como función pura en el render. */
export function accentSwatch(accent: Accent, theme: Theme): string {
  const dark = {
    ambar: '#e8a33d',
    violeta: '#a293f5',
    teal: '#5fc9ae',
  } as const;
  const light = {
    ambar: '#9a6200',
    violeta: '#6a58d6',
    teal: '#0f8a70',
  } as const;
  return (theme === 'light' ? light : dark)[accent];
}

/** Escala tipográfica del lector (multiplica el tamaño base del texto). */
export const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5] as const;

interface ThemeStore {
  theme: Theme;
  accent: Accent;
  fontScale: number;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: Accent) => void;
  fontBigger: () => void;
  fontSmaller: () => void;
}

/** Refleja tema y acento en el <html> (data-theme / data-accent). La base de
 *  global.css usa oscuro+ámbar por defecto; las variantes viven en
 *  [data-theme='light'] y [data-accent='violeta'|'teal']. */
function applyTheme(theme: Theme, accent: Accent, fontScale = 1) {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
    document.documentElement.style.setProperty('--reader-font-scale', String(fontScale));
  }
}

function nearestScaleIndex(v: number): number {
  let best = 1;
  FONT_SCALES.forEach((s, i) => {
    if (Math.abs(s - v) < Math.abs(FONT_SCALES[best] - v)) best = i;
  });
  return best;
}

/** Tema inicial respetando la preferencia del sistema (D9). Solo se usa como
 *  default cuando el usuario no ha guardado una preferencia explícita. */
function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: systemTheme(),
      accent: 'ambar',
      fontScale: 1,

      toggle: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
        applyTheme(next, get().accent, get().fontScale);
        set({ theme: next });
      },
      setTheme: (theme: Theme) => {
        applyTheme(theme, get().accent, get().fontScale);
        set({ theme });
      },
      setAccent: (accent: Accent) => {
        applyTheme(get().theme, accent, get().fontScale);
        set({ accent });
      },
      fontBigger: () => {
        const i = nearestScaleIndex(get().fontScale);
        const fontScale = FONT_SCALES[Math.min(FONT_SCALES.length - 1, i + 1)];
        applyTheme(get().theme, get().accent, fontScale);
        set({ fontScale });
      },
      fontSmaller: () => {
        const i = nearestScaleIndex(get().fontScale);
        const fontScale = FONT_SCALES[Math.max(0, i - 1)];
        applyTheme(get().theme, get().accent, fontScale);
        set({ fontScale });
      },
    }),
    {
      name: 'folio-theme',
      // Al rehidratar desde localStorage, aplica tema y acento guardados al DOM.
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.theme ?? systemTheme(), state?.accent ?? 'ambar', state?.fontScale ?? 1);
      },
    },
  ),
);
