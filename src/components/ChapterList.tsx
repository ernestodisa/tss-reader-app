import type { Chapter } from '../types';

interface ChapterListProps {
  chapters: Chapter[];
  currentIndex: number;
  /** Estado del drawer en móvil (<900px). En desktop el sidebar siempre se ve. */
  open: boolean;
  onSelect: (chapterIndex: number) => void;
  onClose: () => void;
}

/**
 * Índice de capítulos. En desktop (>900px) es un SIDEBAR fijo dentro del grid
 * del lector; en móvil (<900px) se colapsa y se abre como drawer con el toggle
 * ☰ del header (controlado por `open`). Click en un capítulo → salta a su
 * párrafo 0 (vía onSelect, que en ReaderView hace fullStop + seekToParagraph).
 */
export function ChapterList({ chapters, currentIndex, open, onSelect, onClose }: ChapterListProps) {
  return (
    <>
      <div
        className="chapter-sidebar-overlay"
        data-open={open ? 'true' : 'false'}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="chapter-sidebar"
        data-open={open ? 'true' : 'false'}
        aria-label="Índice de capítulos"
      >
        <div className="chapter-sidebar__title">Capítulos</div>
        <ol className="chapter-sidebar__list">
          {chapters.map((chapter, i) => (
            <li key={chapter.id}>
              <button
                type="button"
                className={`chapter-sidebar__item${i === currentIndex ? ' active' : ''}`}
                aria-current={i === currentIndex ? 'true' : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="chapter-sidebar__num">{i + 1}</span>
                <span className="chapter-sidebar__label">
                  {chapter.title || `Capítulo ${i + 1}`}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
    </>
  );
}
