import { useKaraoke } from '../hooks/useKaraoke';
import { tokenize } from '../lib/tokenizer';
import type { Paragraph } from '../types';

interface KaraokeTextProps {
  paragraph: Paragraph;
  /**
   * ¿Es este el párrafo posicionado actualmente? Solo el actual resalta palabra.
   * Se deriva en ReaderView desde chapterIndex/paragraphIndex del store.
   */
  isCurrent?: boolean;
}

export function KaraokeText({ paragraph, isCurrent = true }: KaraokeTextProps) {
  const { wordIndex, isActive } = useKaraoke(paragraph.id, isCurrent);
  const tokens = tokenize(paragraph.text);

  // NOTA: el auto-scroll ya NO vive aquí. Antes KaraokeText hacía
  // scrollIntoView por PALABRA en cada tick, lo que peleaba con el auto-scroll
  // por párrafo del ReaderView y con el guard de scroll manual (~3s). El
  // scroll para mantener visible el contenido activo se centraliza en
  // ReaderView a nivel de párrafo.

  // Render text with word spans
  let charCursor = 0;
  return (
    <div className="karaoke-text">
      {tokens.map((token) => {
        // Render text between tokens (whitespace)
        const gap = paragraph.text.slice(charCursor, token.charStart);
        charCursor = token.charEnd;
        const isHighlighted = isActive && token.wordIndex === wordIndex;
        return (
          <span key={token.wordIndex}>
            {gap}
            <span
              data-word={token.wordIndex}
              className={isHighlighted ? 'word-highlight' : 'word'}
            >
              {paragraph.text.slice(token.charStart, token.charEnd)}
            </span>
          </span>
        );
      })}
      {paragraph.text.slice(charCursor)}
    </div>
  );
}
