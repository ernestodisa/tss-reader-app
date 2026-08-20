import AppKit

// Entry point clásico: en SPM un archivo llamado main.swift ES el punto de
// entrada, así que @main sobre el AppDelegate chocaría ("'main' attribute
// cannot be used in a module that contains top-level code").
//
// El delegate se guarda en una global porque NSApplication.delegate es weak:
// una variable local se liberaría antes de app.run().
// Modo de diagnóstico sin UI: `FolioSay --plan "texto"` imprime los chunks que
// generaría (para comparar 1:1 con `folio-say --dry-run`) y sale. Sin red.
if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--plan" {
    let text = CommandLine.arguments[2...].joined(separator: " ")
    let cfg = Config.load()
    let plan = Chunker.plan(text: text, voice: cfg.voice, speed: cfg.speed)
    print("chunks: \(plan.count)")
    for (i, c) in plan.enumerated() {
        print("[\(i + 1)/\(plan.count)] \(c.text.count) chars, voz \(c.voiceId) (\(c.engine)), speed \(c.speed)")
        print("  texto: \(String(reflecting: c.text))")
    }
    exit(0)
}

// Modo de diagnóstico E2E: `FolioSay --say "texto"` reproduce con el motor
// nativo completo (chunker + /tts + AVQueuePlayer) sin menú ni hotkey, y sale
// al terminar. Sirve para probar red y audio sin conceder Accesibilidad.
if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--say" {
    let text = CommandLine.arguments[2...].joined(separator: " ")
    MainActor.assumeIsolated {
        let player = Player()
        var started = false
        player.onStateChange = { state in
            print("estado: \(state)")
            switch state {
            case .playing: started = true
            case .idle where started: exit(0)  // stop() inicial también emite .idle
            case .error(let message):
                FileHandle.standardError.write(Data("FolioSay: \(message)\n".utf8))
                exit(1)
            default: break
            }
        }
        player.play(text: text)
        // Retener el player mientras corre el run loop.
        objc_setAssociatedObject(NSApplication.shared, "foliosay.player", player, .OBJC_ASSOCIATION_RETAIN)
    }
    RunLoop.main.run()
}

// El top-level code no está aislado al main actor para el compilador, aunque
// en la práctica corre en el hilo principal; assumeIsolated lo hace explícito.
let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.run()
