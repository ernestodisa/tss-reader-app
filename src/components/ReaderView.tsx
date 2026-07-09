import { useDocument } from '../hooks/useDocument';
import { usePlayback } from '../hooks/usePlayback';
import { KaraokeText } from './KaraokeText';
import { PlayerBar } from './PlayerBar';

export function ReaderView() {
  const { doc } = useDocument();
  const { chapterIndex, paragraphIndex } = usePlayback();

  if (!doc) return null;

  const chapter = doc.chapters[chapterIndex];
  if (!chapter) return <p>Capítulo no encontrado</p>;

  // Render current paragraph + surrounding context
  const currentParagraph = chapter.paragraphs[paragraphIndex];

  return (
    <div className="reader-view">
      <div className="reader-header">
        <h2>{chapter.title}</h2>
        <span className="progress">
          {chapterIndex + 1}/{doc.chapters.length} · {paragraphIndex + 1}/{chapter.paragraphs.length}
        </span>
      </div>

      <div className="reader-content">
        {currentParagraph && <KaraokeText paragraph={currentParagraph} />}
      </div>

      <PlayerBar doc={doc} />
    </div>
  );
}
