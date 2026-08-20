import Foundation

/// Configuración compartida con el CLI v0: MISMO archivo, mismas llaves.
/// ~/.config/folio-say/config.json — no duplicar credenciales en otro lado.
struct Config {
    var baseUrl: String
    var clientId: String?
    var clientSecret: String?
    var voice: String
    var speed: Double

    static let defaultBaseUrl = "https://folio.thestandardcurve.com/api"

    /// Alias cortos → voiceId de Edge (los 4 que expone el worker).
    static let voiceAliases: [String: String] = [
        "dalia": "es-MX-DaliaNeural",
        "jorge": "es-MX-JorgeNeural",
        "aria": "en-US-AriaNeural",
        "guy": "en-US-GuyNeural",
    ]

    static var configPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/folio-say/config.json")
    }

    static func resolveVoice(_ input: String) -> String {
        let key = input.trimmingCharacters(in: .whitespaces).lowercased()
        if let full = voiceAliases[key] { return full }
        let trimmed = input.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? voiceAliases["dalia"]! : trimmed
    }

    static func shortVoiceName(_ voiceId: String) -> String {
        voiceAliases.first(where: { $0.value == voiceId })?.key ?? voiceId
    }

    /// Lee el config del CLI. Tolerante: valores raros caen a defaults en vez de
    /// tronar — la app de menú no tiene stderr donde quejarse.
    static func load() -> Config {
        var cfg = Config(baseUrl: defaultBaseUrl, clientId: nil, clientSecret: nil,
                         voice: voiceAliases["dalia"]!, speed: 1.0)
        guard let data = try? Data(contentsOf: configPath),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return cfg }

        let str = { (key: String) -> String? in
            guard let v = raw[key] as? String else { return nil }
            let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
            // Un secret con CR/LF u otros controles es un header ilegal.
            guard !t.isEmpty, t.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f })
            else { return nil }
            return t
        }

        if let base = str("baseUrl"),
           base.range(of: #"^https?://\S+$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            cfg.baseUrl = base.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        }
        cfg.clientId = str("clientId")
        cfg.clientSecret = str("clientSecret")
        if let voice = str("voice") { cfg.voice = resolveVoice(voice) }
        if let n = raw["speed"] as? Double, n.isFinite, n > 0 {
            cfg.speed = min(3, max(0.5, n))
        } else if let s = str("speed"), let n = Double(s), n.isFinite, n > 0 {
            cfg.speed = min(3, max(0.5, n))
        }
        return cfg
    }

    /// Persiste voz/velocidad elegidas en el menú (600, como el CLI). Las
    /// credenciales se conservan tal cual: la app nunca las reescribe.
    func save() {
        var raw: [String: Any] = ["baseUrl": baseUrl, "voice": voice, "speed": speed]
        if let clientId { raw["clientId"] = clientId }
        if let clientSecret { raw["clientSecret"] = clientSecret }
        guard let data = try? JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        else { return }
        let dir = Config.configPath.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? data.write(to: Config.configPath)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600],
                                               ofItemAtPath: Config.configPath.path)
    }

    var hasCredentials: Bool { clientId != nil && clientSecret != nil }
}
