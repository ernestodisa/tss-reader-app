// ── Desbloqueo de audio en iOS/Safari ─────────────────────────────────────
// Dos bloqueos propios de iPhone, ambos invisibles en Android (por eso el bug
// se veía "solo en mi cel"):
//
//  1) GESTO DE USUARIO. Safari solo permite `audio.play()` sobre un elemento
//     que YA fue reproducido dentro de un gesto. Nuestro camino era:
//     tap ▶ → await fetch TTS (red) → new Audio() → play(). El `await` de red
//     rompe la cadena del gesto y el elemento es NUEVO (nunca activado), así
//     que iOS rechaza el play con NotAllowedError → playBlockedCallback →
//     la UI vuelve a pausa: el usuario ve ▶ y "no lee". Con cache caliente a
//     veces colaba (por eso funcionaba a ratos) y en Android nunca falla.
//     Solución: `unlockAudio(el)` reproduce un WAV mudo de 50 ms en el MISMO
//     elemento DENTRO del gesto; a partir de ahí el elemento queda activado y
//     los `src` posteriores (blob del chunk) suenan sin gesto.
//
//  2) INTERRUPTOR DE SILENCIO. Por defecto un <audio> en iPhone entra en la
//     categoría "ambient": si el switch lateral está en silencio, reproduce
//     MUDO (currentTime avanza, karaoke corre, no se oye nada). WebKit 16.4+
//     expone `navigator.audioSession`: con type 'playback' el audio se
//     comporta como el de un reproductor de música — suena con el switch en
//     silencio y sigue en background. Android no tiene el concepto.

const SILENT_WAV =
  'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

/**
 * Declara la sesión de audio como 'playback' (WebKit iOS 16.4+): el audio deja
 * de respetar el interruptor de silencio y sobrevive en background. No-op en
 * navegadores sin `navigator.audioSession`.
 */
export function primeAudioSession(): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
  } catch {
    /* propiedad de solo lectura o no soportada: se sigue sin ella */
  }
}

/**
 * Marca el <audio> como activado por gesto reproduciendo un clip mudo. DEBE
 * llamarse SÍNCRONAMENTE dentro del handler del toque (antes de cualquier
 * await), o iOS ya no considera el gesto vigente.
 *
 * Idempotente y seguro: si el elemento ya está sonando contenido real no se
 * toca, y el `pause()` posterior al clip mudo solo se aplica si el `src` sigue
 * siendo el clip (nunca corta un chunk que arrancó mientras tanto).
 *
 * @returns promesa que resuelve true SOLO si el elemento quedó realmente
 * desbloqueado (el play mudo fue aceptado); el llamador cachea ese true para no
 * repetir el clip en cada toque.
 */
export function unlockAudio(el: HTMLAudioElement): Promise<boolean> {
  primeAudioSession();
  // Hay contenido real cargado/sonando: no lo pisamos con el clip mudo.
  if (!el.paused || (el.currentSrc && !el.currentSrc.startsWith('data:audio/wav'))) {
    return Promise.resolve(false);
  }
  try {
    el.src = SILENT_WAV;
    el.load();
    const p = el.play();
    if (!p || typeof p.then !== 'function') return Promise.resolve(true);
    return p
      .then(() => {
        // Solo pausamos si seguimos en el clip mudo (un load() real pudo haber
        // reemplazado el src mientras la promesa estaba pendiente).
        if (el.currentSrc.startsWith('data:audio/wav')) {
          el.pause();
          try { el.currentTime = 0; } catch { /* ignorable */ }
        }
        return true;
      })
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export { SILENT_WAV };
