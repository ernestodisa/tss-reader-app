import type { Chapter } from '../types';

interface ChapterListProps {
  chapters: Chapter[];
  currentIndex: number;
  onSelect: (chapterIndex: number) => void;
  onClose: () => void;
}

/**
 * Índice de capítulos (drawer). Se abre desde el header del ReaderView.
 * Click en un capítulo → salta a su párrafo 0 (vía onSelect, que en ReaderView
 * hace fullStop + seekToParagraph(idx, 0)).
 */
export function ChapterList({ chapters, currentIndex, onSelect, onClose }: ChapterListProps) {
  return (
    <div className="chapter-list-overlay" onClick={onClose}>
      <aside
        className="chapter-list"
        role="dialog"
        aria-label="Índice de capítulos"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chapter-list-header">
          <h3>Capítulos</h3>
          <button
            type="button"
            className="chapter-list-close"
            onClick={onClose}
            aria-label="Cerrar índice"
            title="Cerrar"
          >
            ✕
          </button>
        </div>
        <ol className="chapter-list-items">
          {chapters.map((chapter, i) => (
            <li key={chapter.id}>
              <button
                type="button"
                className={`chapter-list-item${i === currentIndex ? ' active' : ''}`}
                aria-current={i === currentIndex ? 'true' : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="chapter-list-num">{i + 1}</span>
                <span className="chapter-list-title">{chapter.title || `Capítulo ${i + 1}`}</span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
