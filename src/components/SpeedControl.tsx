import { usePlayback } from '../hooks/usePlayback';

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

export function SpeedControl() {
  const { speed, setSpeed } = usePlayback();

  return (
    <div className="speed-control">
      {SPEEDS.map((s) => (
        <button
          key={s}
          className={speed === s ? 'active' : ''}
          onClick={() => setSpeed(s)}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}
