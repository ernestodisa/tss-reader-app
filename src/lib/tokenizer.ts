import { TokenPosition } from '../types';

export function tokenize(text: string): TokenPosition[] {
  const tokens: TokenPosition[] = [];
  const regex = /\S+/g;
  let match;
  let wordIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      wordIndex,
      charStart: match.index,
      charEnd: match.index + match[0].length,
    });
    wordIndex++;
  }
  return tokens;
}
