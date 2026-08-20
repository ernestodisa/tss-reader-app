import AVFoundation
import Foundation

/// Motor de reproducción nativo: descarga secuencial con prefetch (mientras
/// suena el chunk N ya baja el N+1) y encolado gapless en AVQueuePlayer.
/// El estado se publica en main para que el menú/ícono reaccionen.
@MainActor
final class Player: NSObject {
    enum State: Equatable {
        case idle
        case loading
        case playing(current: Int, total: Int)
        case paused(current: Int, total: Int)
        case error(String)
    }

    var onStateChange: ((State) -> Void)?

    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    private var queuePlayer: AVQueuePlayer?
    private var downloadTask: Task<Void, Never>?
    /// Velocidad pedida al backend al arrancar esta lectura; la velocidad "en
    /// vivo" del menú se aplica como rate = deseada/pedida sobre el player.
    private var requestedSpeed: Double = 1.0
    private var liveSpeed: Double = 1.0
    private var itemIndex: [ObjectIdentifier: Int] = [:]
    private var totalChunks = 0
    private var enqueuedCount = 0
    private var downloadFinished = false
    private var tempFiles: [URL] = []
    private var endObserver: NSObjectProtocol?

    private let stateDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".cache/folio-say")

    var isActive: Bool {
        if case .idle = state { return false }
        if case .error = state { return false }
        return true
    }

    // MARK: - API

    /// Toggle del hotkey: leyendo → stop; pausado → reanuda; idle → nueva lectura.
    func toggle(textProvider: () -> String?) {
        switch state {
        case .playing:
            stop()
        case .paused:
            resume()
        default:
            guard let text = textProvider(), !text.isEmpty else {
                state = .error("No hay texto seleccionado")
                return
            }
            play(text: text)
        }
    }

    func play(text: String) {
        stop()
        // Cortesía con la v0: si el Quick Action dejó algo sonando, callarlo
        // antes de encimarle nuestra voz.
        CLIGuard.stopCLIPlayback()

        let config = Config.load()
        requestedSpeed = config.speed
        liveSpeed = config.speed
        let chunks = Chunker.plan(text: text, voice: config.voice, speed: config.speed)
        guard !chunks.isEmpty else {
            state = .error("El texto no tiene nada pronunciable")
            return
        }

        totalChunks = chunks.count
        enqueuedCount = 0
        downloadFinished = false
        state = .loading

        let player = AVQueuePlayer()
        player.actionAtItemEnd = .advance
        queuePlayer = player
        observeEnd(of: player)

        let client = TTSClient(config: config)
        downloadTask = Task { [weak self] in
            do {
                for (i, chunk) in chunks.enumerated() {
                    let data = try await client.fetchAudio(for: chunk)
                    try Task.checkCancellation()
                    await self?.enqueue(data: data, index: i)
                }
                await MainActor.run { self?.downloadFinished = true }
            } catch is CancellationError {
                // stop() ya limpió; nada que reportar.
            } catch TTSError.cancelled {
                // ídem
            } catch {
                await MainActor.run { self?.fail(error.localizedDescription) }
            }
        }
    }

    func pause() {
        guard case .playing(let cur, let total) = state else { return }
        queuePlayer?.pause()
        state = .paused(current: cur, total: total)
    }

    func resume() {
        guard case .paused(let cur, let total) = state else { return }
        applyRate()
        state = .playing(current: cur, total: total)
    }

    func stop() {
        downloadTask?.cancel()
        downloadTask = nil
        if let obs = endObserver { NotificationCenter.default.removeObserver(obs) }
        endObserver = nil
        queuePlayer?.pause()
        queuePlayer?.removeAllItems()
        queuePlayer = nil
        itemIndex.removeAll()
        cleanupTempFiles()
        state = .idle
    }

    /// Cambia la velocidad EN VIVO (rate relativo) y la guarda para próximas
    /// lecturas (el backend cachea por velocidad — la pedida no cambia a media
    /// lectura para no tirar el prefetch ni el cache).
    func setSpeed(_ speed: Double) {
        liveSpeed = min(3, max(0.5, speed))
        var cfg = Config.load()
        cfg.speed = liveSpeed
        cfg.save()
        if case .playing = state { applyRate() }
    }

    // MARK: - Internos

    private func applyRate() {
        guard let player = queuePlayer else { return }
        player.rate = Float(liveSpeed / requestedSpeed)
    }

    private func enqueue(data: Data, index: Int) {
        guard let player = queuePlayer else { return }
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        // Prefijo propio para no chocar con los chunk-N.mp3 del CLI v0.
        let file = stateDir.appendingPathComponent("menubar-chunk-\(index).mp3")
        do {
            try data.write(to: file, options: .completeFileProtection)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch {
            fail("No se pudo escribir el audio temporal: \(error.localizedDescription)")
            return
        }
        tempFiles.append(file)

        let item = AVPlayerItem(url: file)
        // Rate ≠ 1 sin picar la voz (corrección de pitch en dominio de tiempo).
        item.audioTimePitchAlgorithm = .timeDomain
        itemIndex[ObjectIdentifier(item)] = index
        player.insert(item, after: nil)
        enqueuedCount += 1

        // Arranque inicial o rescate tras quedarnos sin cola (descarga atrasada).
        if case .loading = state {
            applyRate()
            player.play()
            state = .playing(current: currentQueuedIndex(in: player) + 1, total: totalChunks)
        }
    }

    /// Índice (0-based) del chunk al frente de la cola del player.
    private func currentQueuedIndex(in player: AVQueuePlayer) -> Int {
        guard let first = player.items().first, let idx = itemIndex[ObjectIdentifier(first)] else { return 0 }
        return idx
    }

    private func observeEnd(of player: AVQueuePlayer) {
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main
        ) { [weak self] note in
            guard let item = note.object as? AVPlayerItem else { return }
            Task { @MainActor in
                guard let self, let finished = self.itemIndex[ObjectIdentifier(item)] else { return }
                self.itemDidFinish(index: finished)
            }
        }
    }

    private func itemDidFinish(index: Int) {
        if index + 1 >= totalChunks {
            stop()
            return
        }
        // ¿Terminó lo encolado pero la descarga va atrás? → "cargando" honesto;
        // enqueue() rearranca cuando llegue el siguiente chunk.
        if index + 1 >= enqueuedCount && !downloadFinished {
            state = .loading
        } else if case .playing = state {
            state = .playing(current: index + 2, total: totalChunks)
        }
    }

    private func fail(_ message: String) {
        stop()
        state = .error(message)
    }

    private func cleanupTempFiles() {
        for f in tempFiles { try? FileManager.default.removeItem(at: f) }
        tempFiles.removeAll()
    }
}
