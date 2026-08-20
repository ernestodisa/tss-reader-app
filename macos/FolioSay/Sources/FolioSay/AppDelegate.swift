import AppKit

/// Capa de UI: ícono en la barra de menús + menú reconstruido en cada apertura.
/// Todo corre en main (Player es @MainActor y NSStatusItem también lo exige).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private let player = Player()
    private var hotKey: HotKey?
    /// Se refleja en el menú: sin hotkey la app sigue sirviendo por menú, pero
    /// el usuario tiene que enterarse (otra app ya registró ⌃⌥⌘L).
    private var hotKeyFailed = false
    /// Vuelve el ícono a idle tras un error; se cancela si algo nuevo pasa.
    private var errorResetTask: Task<Void, Never>?

    private let speeds: [Double] = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    /// Orden fijo (Config.voiceAliases es un dict, sin orden estable).
    private let voiceOrder = ["dalia", "jorge", "aria", "guy"]

    // MARK: - Ciclo de vida

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Agente: sin ícono en el Dock ni menú de app. Debe ir antes de crear
        // el status item para que el sistema no muestre la app un instante.
        NSApp.setActivationPolicy(.accessory)

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = icon(for: .idle)
        let menu = NSMenu()
        menu.delegate = self          // menuNeedsUpdate reconstruye al abrir
        menu.autoenablesItems = false // controlamos isEnabled a mano
        item.menu = menu
        statusItem = item

        player.onStateChange = { [weak self] state in
            // El Player ya publica en main, pero el contrato de NSStatusItem es
            // explícito: nos aseguramos igual.
            Task { @MainActor in self?.render(state: state) }
        }

        hotKey = HotKey { [weak self] in
            Task { @MainActor in self?.readSelection() }
        }
        hotKeyFailed = (hotKey == nil)

        // Pedimos Accesibilidad UNA vez al arrancar y sin bloquear: el diálogo
        // del sistema es asíncrono y el usuario debe reiniciar la app tras
        // concederlo. Si lo niega, "Leer portapapeles" sigue funcionando.
        SelectionCapture.ensureAccessibility(prompt: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        player.stop() // borra los mp3 temporales de ~/.cache/folio-say
    }

    // MARK: - Acciones

    @objc private func readSelection() {
        errorResetTask?.cancel()
        player.toggle(textProvider: SelectionCapture.grabSelection)
    }

    @objc private func readClipboard() {
        errorResetTask?.cancel()
        guard let text = SelectionCapture.clipboardText() else {
            render(state: .error("El portapapeles está vacío"))
            scheduleErrorReset()
            return
        }
        player.play(text: text)
    }

    @objc private func togglePause() {
        if case .playing = player.state { player.pause() } else { player.resume() }
    }

    @objc private func stopPlayback() {
        player.stop()
    }

    @objc private func chooseVoice(_ sender: NSMenuItem) {
        guard let alias = sender.representedObject as? String,
              let voiceId = Config.voiceAliases[alias] else { return }
        var cfg = Config.load()
        cfg.voice = voiceId
        cfg.save()
        // A propósito NO cortamos la lectura en curso: el plan de chunks ya se
        // pidió con la voz anterior y el backend cachea por voz. Aplica a la
        // próxima lectura.
    }

    @objc private func chooseSpeed(_ sender: NSMenuItem) {
        guard let speed = sender.representedObject as? Double else { return }
        player.setSpeed(speed) // persiste en Config y ajusta el rate en vivo
    }

    @objc private func quit() {
        player.stop()
        NSApp.terminate(nil)
    }

    // MARK: - Ícono y estado

    private func render(state: Player.State) {
        statusItem?.button?.image = icon(for: state)
        if case .error(let message) = state {
            statusItem?.button?.toolTip = message
            scheduleErrorReset()
        } else {
            errorResetTask?.cancel()
            statusItem?.button?.toolTip = "FolioSay"
        }
    }

    /// Tras ~4 s el triángulo de error vuelve a "book": el mensaje sigue en el
    /// menú hasta la próxima lectura, pero la barra no se queda alarmando.
    private func scheduleErrorReset() {
        errorResetTask?.cancel()
        errorResetTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled, let self else { return }
            if case .error = self.player.state {
                self.statusItem?.button?.image = self.icon(for: .idle)
            }
        }
    }

    private func icon(for state: Player.State) -> NSImage? {
        let name: String
        switch state {
        case .idle:    name = "book"
        case .loading: name = "arrow.triangle.2.circlepath"
        case .playing: name = "waveform"
        case .paused:  name = "pause.circle"
        case .error:   name = "exclamationmark.triangle"
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "FolioSay")
        // Template = el sistema lo tiñe solo (menu bar clara/oscura, resaltado).
        image?.isTemplate = true
        return image
    }

    // MARK: - Menú

    func menuNeedsUpdate(_ menu: NSMenu) {
        // Reconstruir completo en cada apertura: el config puede haber cambiado
        // desde el CLI y el estado del player cambia sin avisarle al menú.
        menu.removeAllItems()
        let config = Config.load()
        let state = player.state

        add(to: menu, title: "Leer selección (⌃⌥⌘L)", action: #selector(readSelection))

        switch state {
        case .playing:
            add(to: menu, title: "Pausar", action: #selector(togglePause))
            add(to: menu, title: "Detener", action: #selector(stopPlayback))
        case .paused:
            add(to: menu, title: "Reanudar", action: #selector(togglePause))
            add(to: menu, title: "Detener", action: #selector(stopPlayback))
        case .loading:
            add(to: menu, title: "Detener", action: #selector(stopPlayback))
        default:
            break
        }

        menu.addItem(.separator())
        menu.addItem(voiceMenuItem(current: config.voice))
        menu.addItem(speedMenuItem(current: config.speed))

        menu.addItem(.separator())
        add(to: menu, title: "Leer portapapeles", action: #selector(readClipboard))

        menu.addItem(.separator())
        let status = NSMenuItem(title: statusLine(state: state, config: config), action: nil, keyEquivalent: "")
        status.isEnabled = false
        menu.addItem(status)
        if hotKeyFailed {
            let warn = NSMenuItem(title: "Atajo ⌃⌥⌘L no disponible (otra app lo usa)",
                                  action: nil, keyEquivalent: "")
            warn.isEnabled = false
            menu.addItem(warn)
        }

        menu.addItem(.separator())
        add(to: menu, title: "Salir de FolioSay", action: #selector(quit), key: "q")
    }

    private func statusLine(state: Player.State, config: Config) -> String {
        // Las credenciales mandan: sin ellas nada va a sonar, dígalo el estado
        // lo que diga.
        guard config.hasCredentials else { return "Sin credenciales — corre folio-say --setup" }
        switch state {
        case .idle:                      return "Listo · voz \(Config.shortVoiceName(config.voice))"
        case .loading:                   return "Cargando audio…"
        case .playing(let c, let t):     return "Leyendo \(c)/\(t)…"
        case .paused(let c, let t):      return "Pausado \(c)/\(t)"
        case .error(let message):        return message
        }
    }

    private func voiceMenuItem(current: String) -> NSMenuItem {
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for alias in voiceOrder {
            guard let voiceId = Config.voiceAliases[alias] else { continue }
            let item = NSMenuItem(title: alias.capitalized, action: #selector(chooseVoice(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = alias
            item.state = (voiceId == current) ? .on : .off
            submenu.addItem(item)
        }
        let parent = NSMenuItem(title: "Voz", action: nil, keyEquivalent: "")
        parent.submenu = submenu
        return parent
    }

    private func speedMenuItem(current: Double) -> NSMenuItem {
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for speed in speeds {
            let label = speed == rint(speed) ? "\(Int(speed))×" : "\(speed)×"
            let item = NSMenuItem(title: label, action: #selector(chooseSpeed(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = speed
            // Comparación con tolerancia: el config guarda Double y round-trip
            // por JSON puede no dar igualdad exacta.
            item.state = abs(speed - current) < 0.001 ? .on : .off
            submenu.addItem(item)
        }
        let parent = NSMenuItem(title: "Velocidad", action: nil, keyEquivalent: "")
        parent.submenu = submenu
        return parent
    }

    @discardableResult
    private func add(to menu: NSMenu, title: String, action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self // sin target el responder chain no llega a un agente
        menu.addItem(item)
        return item
    }
}
