// Íconos SVG propios para las acciones del player/lector. Motivo: caracteres
// Unicode como ⬇ ⬆ ↩ ⏳ ▶ son "emoji-default" y iOS los pinta como EMOJI de
// color (Android/desktop los dibujan como glifos planos) — se veían ajenos al
// diseño. SVG con stroke=currentColor hereda color y peso visual del contexto
// en TODAS las plataformas. Tamaño por defecto 1em → escala con la tipografía.

interface IconProps {
  size?: string;
}

function base(size?: string) {
  return {
    width: size ?? '1em',
    height: size ?? '1em',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { verticalAlign: '-0.12em' },
  };
}

/** Flecha de descarga (bandeja). */
export function IconDownload({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

/** Flecha hacia arriba (actualización disponible). */
export function IconUp({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12 20V6" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

/** Regresar a la lectura (flecha de retorno). */
export function IconReturn({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
    </svg>
  );
}

/** Palomita (capítulo listo sin conexión). */
export function IconCheck({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="m5 13 5 5L19 7" />
    </svg>
  );
}

/** Triángulo de play (evita el ▶ Unicode, emoji en iOS). */
export function IconPlay({ size }: IconProps) {
  return (
    <svg {...base(size)} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

/** Spinner de carga (sustituye al ⏳, que iOS pinta como emoji). La animación
 *  vive en global.css (.icon-spin). */
export function IconSpinner({ size }: IconProps) {
  return (
    <svg {...base(size)} className="icon-spin">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

/** Equis de cerrar (evita el × Unicode, emoji en iOS). */
export function IconClose({ size }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}
