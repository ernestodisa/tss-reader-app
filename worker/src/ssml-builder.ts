export function buildSSML(text: string, voiceId: string, speed: number): string {
  // Relative rate with sign: speed=1 → "+0%", 1.5 → "+50%", 0.8 → "-20%"
  const pct = Math.round((speed - 1) * 100);
  const rate = (pct >= 0 ? '+' : '') + pct + '%';
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
    <voice name="${voiceId}">
      <prosody rate="${rate}">
        ${escapeXml(text)}
      </prosody>
    </voice>
  </speak>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
