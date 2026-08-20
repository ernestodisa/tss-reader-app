import Foundation

/// Cliente del backend /tts de Folio. Mismo contrato y misma política de
/// reintentos que el CLI v0 (cli/folio-say.ts): 429 → 3 reintentos con
/// retryAfterMs, cuerpo no-MP3 → 2, fallo de red → 1.
enum TTSError: LocalizedError {
    case auth
    case rateLimited
    case badAudio
    case http(Int, String)
    case network(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .auth: return "Credenciales inválidas o expiradas. Revisa el service token (folio-say --setup)."
        case .rateLimited: return "El backend sigue limitando las peticiones (429)."
        case .badAudio: return "El backend devolvió audio inválido varias veces seguidas."
        case .http(let code, let detail): return "El backend respondió HTTP \(code)\(detail.isEmpty ? "" : ": \(detail)")"
        case .network(let msg): return "No se pudo contactar el backend: \(msg)"
        case .cancelled: return "Lectura cancelada"
        }
    }
}

struct TTSClient {
    let config: Config

    private var ttsURL: URL {
        URL(string: config.baseUrl.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression) + "/tts")!
    }

    /// Un MP3 válido arranca con frame sync MPEG o etiqueta ID3. Lección del
    /// repo: Edge TTS responde a veces 200 con 0 bytes o cuerpo no-audio.
    static func looksLikeMp3(_ data: Data) -> Bool {
        guard data.count >= 3 else { return false }
        let isId3 = data[0] == 0x49 && data[1] == 0x44 && data[2] == 0x33
        let isMpegSync = data[0] == 0xff && (data[1] & 0xe0) == 0xe0
        return isId3 || isMpegSync
    }

    func fetchAudio(for chunk: TTSChunk) async throws -> Data {
        var rateRetries = 0, audioRetries = 0, netRetries = 0

        while true {
            try Task.checkCancellation()
            var req = URLRequest(url: ttsURL)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let id = config.clientId, let secret = config.clientSecret {
                req.setValue(id, forHTTPHeaderField: "CF-Access-Client-Id")
                req.setValue(secret, forHTTPHeaderField: "CF-Access-Client-Secret")
            }
            req.timeoutInterval = 30
            req.httpBody = try JSONSerialization.data(withJSONObject: [
                "text": chunk.text,
                "voiceId": chunk.voiceId,
                "engine": chunk.engine,
                "speed": chunk.speed,
                "format": "mp3",
            ] as [String: Any])

            let data: Data
            let resp: HTTPURLResponse
            do {
                let (d, r) = try await URLSession.shared.data(for: req)
                data = d
                resp = r as! HTTPURLResponse
            } catch is CancellationError {
                throw TTSError.cancelled
            } catch let err as URLError where err.code == .cancelled {
                throw TTSError.cancelled
            } catch {
                netRetries += 1
                if netRetries > 1 { throw TTSError.network(error.localizedDescription) }
                try await Task.sleep(nanoseconds: 700_000_000)
                continue
            }

            if resp.statusCode == 401 || resp.statusCode == 403 { throw TTSError.auth }

            if resp.statusCode == 429 {
                rateRetries += 1
                if rateRetries > 3 { throw TTSError.rateLimited }
                let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let waitMs = body?["retryAfterMs"] as? Double ?? 1000
                try await Task.sleep(nanoseconds: UInt64(max(0, waitMs)) * 1_000_000)
                continue
            }

            guard (200..<300).contains(resp.statusCode) else {
                let detail = String(String(data: data, encoding: .utf8)?.prefix(200) ?? "")
                throw TTSError.http(resp.statusCode, detail)
            }

            guard Self.looksLikeMp3(data) else {
                audioRetries += 1
                if audioRetries > 2 { throw TTSError.badAudio }
                try await Task.sleep(nanoseconds: 800_000_000)
                continue
            }

            return data
        }
    }
}
