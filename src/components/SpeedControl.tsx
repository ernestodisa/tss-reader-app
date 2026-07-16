import { usePlayback } from '../hooks/usePlayback';

const STEP = 0.25;
const MIN = 0.5;
const MAX = 2;

// "1×", "1.25×", "1.5×" — sin ceros colgantes.
function formatSpeed(s: number): string {
  return `${parseFloat(s.toFixed(2))}×`;
}

export function SpeedControl() {
  const { speed, setSpeed } = usePlayback();

  const dec = () => setSpeed(Math.max(MIN, parseFloat((speed - STEP).toFixed(2))));
  const inc = () => setSpeed(Math.min(MAX, parseFloat((speed + STEP).toFixed(2))));

  return (
    <div className="fp-speed">
      <button
        className="fp-speed-btn"
        onClick={dec}
        disabled={speed <= MIN}
        aria-label="Reducir velocidad"
      >
        −
      </button>
      <span className="fp-speed-label" aria-live="polite">{formatSpeed(speed)}</span>
      <button
        className="fp-speed-btn"
        onClick={inc}
        disabled={speed >= MAX}
        aria-label="Aumentar velocidad"
      >
        +
      </button>
    </div>
  );
}
