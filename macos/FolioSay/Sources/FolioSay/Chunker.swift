import Foundation

/// Puerto fiel de src/agents/chunker.ts (sin wordOffsetMap: aquí no hay karaoke).
/// Las lecciones caras que carga el original y que este puerto CONSERVA:
///  - corte lossless (solo en fronteras de whitespace, sin espacios inventados)
///  - no partir palabras (URLs/hashes) salvo runs monolíticos > tope del worker
///  - párrafos sin contenido pronunciable ("• • •", "***") → 0 chunks
struct TTSChunk {
    let text: String
    let voiceId: String
    let engine: String
    let speed: Double
}

enum Chunker {
    static let maxChunkChars = 250  // mismo tope que la app web y el CLI
    static let hardLimit = 230      // tamaño objetivo por oración
    static let workerMax = 1900     // el worker rechaza > 2000

    /// "engine::voiceId" o voiceId crudo (compat: crudo → edge).
    static func decodeVoiceId(_ encoded: String) -> (engine: String, voiceId: String) {
        guard let range = encoded.range(of: "::") else { return ("edge", encoded) }
        return (String(encoded[..<range.lowerBound]), String(encoded[range.upperBound...]))
    }

    /// Texto completo → plan de chunks. Un párrafo = bloque separado por línea
    /// en blanco, la misma unidad que usan la app web y el CLI.
    static func plan(text: String, voice: String, speed: Double) -> [TTSChunk] {
        let (engine, voiceId) = decodeVoiceId(voice)
        let parts = splitParagraphs(text)
        var out: [TTSChunk] = []
        for p in parts {
            out.append(contentsOf: chunkParagraph(p, voiceId: voiceId, engine: engine, speed: speed))
        }
        return out
    }

    static func splitParagraphs(_ text: String) -> [String] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        let regex = try! NSRegularExpression(pattern: #"\n\s*\n"#)
        let ns = normalized as NSString
        var parts: [String] = []
        var last = 0
        for m in regex.matches(in: normalized, range: NSRange(location: 0, length: ns.length)) {
            parts.append(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            last = m.range.location + m.range.length
        }
        parts.append(ns.substring(from: last))
        return parts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func chunkParagraph(_ paragraph: String, voiceId: String, engine: String, speed: Double) -> [TTSChunk] {
        // Sin letras ni números → nada pronunciable → 0 chunks (Edge devolvería
        // 200 con 0 bytes y la reproducción se plantaría reintentando).
        guard paragraph.range(of: #"[\p{L}\p{N}]"#, options: .regularExpression) != nil else { return [] }

        let make = { (text: String) in TTSChunk(text: text, voiceId: voiceId, engine: engine, speed: speed) }

        if paragraph.count <= maxChunkChars { return [make(paragraph)] }

        var chunks: [TTSChunk] = []
        var current = ""
        for sentence in splitBySentence(paragraph) {
            // Lossless: cortar solo si la frontera actual es whitespace, y jamás
            // insertar espacios que el párrafo original no tenía.
            let atWhitespaceBoundary =
                (current.last.map { $0.isWhitespace } ?? false) ||
                (sentence.first.map { $0.isWhitespace } ?? false)
            if current.count + sentence.count > maxChunkChars, !current.isEmpty, atWhitespaceBoundary {
                chunks.append(make(current))  // sin trim: slice fiel del párrafo
                current = ""
            }
            current += sentence
        }
        if !current.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            chunks.append(make(current))
        }
        return chunks
    }

    /// Corta por fin de oración preservando el delimitador; oraciones gigantes
    /// sin puntuación se parten por el último espacio antes del límite, dejando
    /// palabras ENTERAS salvo runs monolíticos > workerMax.
    static func splitBySentence(_ text: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: #"[^.!?]+[.!?]+\s*|[^.!?]+$"#)
        let ns = text as NSString
        var sentences = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
            .map { ns.substring(with: $0.range) }
        if sentences.isEmpty { sentences = [text] }

        var out: [String] = []
        for s in sentences {
            if s.count <= hardLimit { out.append(s); continue }
            // Trabajar en UTF-16 (NSString) para índices baratos, como el original en JS.
            var rest = s as NSString
            while rest.length > hardLimit {
                var cut = rest.range(of: " ", options: .backwards,
                                     range: NSRange(location: 0, length: hardLimit + 1)).location
                if cut == NSNotFound || cut <= 0 {
                    // Sin espacio en la ventana: buscar el PRÓXIMO (palabra entera)
                    // o el fin; solo si eso excede el tope del worker se corta a
                    // media palabra (caso patológico).
                    let next = rest.range(of: " ", range: NSRange(location: hardLimit, length: rest.length - hardLimit)).location
                    cut = next == NSNotFound ? rest.length - 1 : next
                    if cut + 1 > workerMax { cut = workerMax - 1 }
                }
                out.append(rest.substring(to: cut + 1))
                rest = rest.substring(from: cut + 1) as NSString
            }
            if rest.length > 0 { out.append(rest as String) }
        }
        return out
    }
}
