import { useRef, useEffect } from 'react';
import { useKaraoke } from '../hooks/useKaraoke';
import { tokenize } from '../lib/tokenizer';
import type { Paragraph } from '../types';

interface KaraokeTextProps {
  paragraph: Paragraph;
}

export function KaraokeText({ paragraph }: KaraokeTextProps) {
  const { wordIndex, isActive } = useKaraoke(paragraph.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const tokens = tokenize(paragraph.text);

  // Auto-scroll to keep active word visible
  useEffect(() => {
    if (!isActive || wordIndex < 0) return;
    const activeSpan = containerRef.current?.querySelector(`[data-word="${wordIndex}"]`);
    activeSpan?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [wordIndex, isActive]);

  // Render text with word spans
  let charCursor = 0;
  return (
    <div ref={containerRef} className="karaoke-text">
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
