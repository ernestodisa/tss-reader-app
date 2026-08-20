import AppKit

/// Panel flotante tipo "karaoke": muestra el texto del chunk que suena y
/// resalta la palabra estimada actual.
///
/// Restricciones no obvias que explican el diseño:
/// - Es un NSPanel `.nonactivatingPanel` + `.borderless`: la app es un agente
///   (`.accessory`) y el panel NUNCA debe robar foco a la app donde el usuario
///   está leyendo/escribiendo. Sin título y sin botones — se mueve arrastrando
///   el fondo.
/// - El backend no manda marcas por palabra: la palabra actual se ESTIMA
///   repartiendo la fracción del chunk proporcionalmente al largo de cada
///   palabra (ver `wordIndex(for:)`). Sirve para seguir la voz, no para doblaje.
@MainActor
final class KaraokePanel {

    /// Subclase mínima solo para dejar explícito que jamás es key window.
    /// (`.nonactivatingPanel` ya lo implica, pero conviene que se lea en el código.)
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    // MARK: - Constantes de layout

    private static let width: CGFloat = 560
    private static let padding: CGFloat = 22
    private static let fontSize: CGFloat = 17
    private static let lineSpacing: CGFloat = 6
    /// El chunk máximo son ~250 chars; a 520pt de ancho eso cabe en ~4 líneas.
    /// Topamos en 5 para que un texto raro no crezca sin control.
    private static let maxLines = 5

    /// Dónde lo dejó el usuario. `static` a propósito: la posición sobrevive a
    /// que el panel se cree y destruya entre lecturas, pero NO se persiste a
    /// disco — es memoria de sesión.
    private static var userOrigin: NSPoint?

    // MARK: - Estado

    private let panel: Panel
    private let label: NSTextField
    private var currentText = ""
    /// Rangos (en NSString) de cada palabra del texto actual, con su peso.
    private var wordRanges: [NSRange] = []
    /// Suma acumulada normalizada 0–1 del peso de las palabras; se usa para
    /// mapear fracción → índice de palabra sin recalcular en cada tick.
    private var cumulative: [Double] = []
    private var highlighted = -1
    private var moveObserver: NSObjectProtocol?

    // MARK: - Ciclo de vida

    init() {
        panel = Panel(
            contentRect: NSRect(x: 0, y: 0, width: KaraokePanel.width, height: 80),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // Sin sombra de "ventana activa" ni animación al cerrar: es un HUD.
        panel.animationBehavior = .none
        panel.ignoresMouseEvents = false

        let effect = NSVisualEffectView(frame: panel.contentView?.bounds ?? .zero)
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.autoresizingMask = [.width, .height]
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 12
        effect.layer?.masksToBounds = true
        // El HUD de macOS ya es oscuro, pero el contraste con fondos claros
        // detrás flaquea; una capa negra al 35% asegura texto blanco legible.
        let scrim = NSView(frame: effect.bounds)
        scrim.autoresizingMask = [.width, .height]
        scrim.wantsLayer = true
        scrim.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.35).cgColor
        effect.addSubview(scrim)

        label = NSTextField(labelWithString: "")
        label.isEditable = false
        label.isSelectable = false      // seleccionar texto pediría foco
        label.drawsBackground = false
        label.isBezeled = false
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = KaraokePanel.maxLines
        label.cell?.wraps = true
        label.cell?.truncatesLastVisibleLine = true
        label.frame = NSRect(
            x: KaraokePanel.padding,
            y: KaraokePanel.padding,
            width: KaraokePanel.width - KaraokePanel.padding * 2,
            height: 40
        )
        // Sin autoresizing: resizeToFit() administra el frame a mano y la
        // máscara peleaba con él (el label se iba encogiendo en cada resize).
        label.autoresizingMask = []
        effect.addSubview(label)

        panel.contentView = effect

        // Si el usuario lo arrastra, esa posición manda de aquí en adelante.
        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification, object: panel, queue: .main
        ) { [weak panel] _ in
            // La cola es .main, pero el closure no está aislado al main actor
            // para el compilador; el Task lo hace explícito.
            Task { @MainActor in
                guard let panel else { return }
                KaraokePanel.userOrigin = panel.frame.origin
            }
        }
    }

    deinit {
        if let moveObserver { NotificationCenter.default.removeObserver(moveObserver) }
    }

    // MARK: - API

    var isVisible: Bool { panel.isVisible }

    /// Muestra el panel: la primera vez (o si nunca se arrastró) queda centrado
    /// horizontalmente y ~120pt bajo el borde superior de la pantalla donde
    /// está el mouse; después respeta a donde el usuario lo haya movido.
    func showNear() {
        if let origin = KaraokePanel.userOrigin {
            panel.setFrameOrigin(origin)
        } else {
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first { $0.frame.contains(mouse) }
                ?? NSScreen.main
                ?? NSScreen.screens.first
            if let visible = screen?.visibleFrame {
                let size = panel.frame.size
                let x = visible.midX - size.width / 2
                // AppKit tiene el origen abajo-izquierda: "120pt bajo el borde
                // superior" es maxY - 120 - alto.
                let y = visible.maxY - 120 - size.height
                panel.setFrameOrigin(NSPoint(x: x, y: max(visible.minY, y)))
            }
        }
        // orderFrontRegardless: la app es .accessory y puede no estar activa;
        // orderFront normal no lo mostraría sobre la app en primer plano.
        panel.orderFrontRegardless()
    }

    func hide() {
        panel.orderOut(nil)
    }

    /// Un tick de progreso. `chunkIndex` no se usa para decidir el re-render
    /// (dos chunks distintos pueden repetir texto, y el texto es lo que se
    /// pinta), pero se acepta por si el llamador quiere trazarlo.
    func update(chunkIndex: Int, text: String, fraction: Double) {
        if text != currentText {
            currentText = text
            buildWordIndex(for: text)
            highlighted = -1
        }
        let index = wordIndex(for: fraction)
        guard index != highlighted else { return } // evita repintar 10×/s de balde
        highlighted = index
        render(highlight: index)
    }

    // MARK: - Estimación de palabra

    /// Parte el texto por whitespace CONSERVANDO los rangos originales, con la
    /// puntuación pegada a su palabra ("hola," es una sola palabra). No se usa
    /// `enumerateSubstrings(.byWords)` a propósito: ese modo tira la puntuación
    /// y los guiones, y los rangos dejarían de cuadrar con lo que se pinta.
    private func buildWordIndex(for text: String) {
        wordRanges = []
        cumulative = []

        let ns = text as NSString
        var start: Int? = nil
        var weights: [Double] = []

        func closeWord(end: Int) {
            guard let s = start else { return }
            let range = NSRange(location: s, length: end - s)
            wordRanges.append(range)
            // Peso = número de caracteres + 1 de "respiro": sin el +1 las
            // palabras de 1–2 letras pasarían casi sin resaltarse.
            weights.append(Double(range.length) + 1)
            start = nil
        }

        for i in 0..<ns.length {
            let scalarString = ns.substring(with: NSRange(location: i, length: 1))
            let isSpace = scalarString.unicodeScalars.allSatisfy {
                CharacterSet.whitespacesAndNewlines.contains($0)
            }
            if isSpace {
                closeWord(end: i)
            } else if start == nil {
                start = i
            }
        }
        closeWord(end: ns.length)

        let total = weights.reduce(0, +)
        guard total > 0 else { return }
        var acc = 0.0
        cumulative = weights.map { w in
            acc += w
            return acc / total
        }
    }

    /// Mapea fracción del chunk → índice de palabra por peso acumulado.
    private func wordIndex(for fraction: Double) -> Int {
        guard !cumulative.isEmpty else { return -1 }
        let f = min(1, max(0, fraction))
        for (i, upper) in cumulative.enumerated() where f < upper { return i }
        return cumulative.count - 1
    }

    // MARK: - Render

    private func render(highlight: Int) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = KaraokePanel.lineSpacing
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.alignment = .left

        let base = NSFont.systemFont(ofSize: KaraokePanel.fontSize, weight: .regular)
        let attributed = NSMutableAttributedString(
            string: currentText,
            attributes: [
                .font: base,
                .foregroundColor: NSColor.white.withAlphaComponent(0.9),
                .paragraphStyle: paragraph
            ]
        )

        if highlight >= 0, highlight < wordRanges.count {
            let range = wordRanges[highlight]
            attributed.addAttributes([
                .font: NSFont.systemFont(ofSize: KaraokePanel.fontSize, weight: .bold),
                .foregroundColor: NSColor.systemYellow
            ], range: range)
        }

        label.attributedStringValue = attributed
        resizeToFit(attributed)
    }

    /// Ajusta el alto del panel al texto (topado a `maxLines`) manteniendo fija
    /// la esquina SUPERIOR: en AppKit crecer hacia abajo significa bajar el
    /// origin, si no el panel "salta" cada vez que cambia el número de líneas.
    private func resizeToFit(_ attributed: NSAttributedString) {
        let textWidth = KaraokePanel.width - KaraokePanel.padding * 2
        // Medir con el CELL del propio NSTextField, no con boundingRect: el
        // cell conoce su wrapping real y boundingRect se quedaba corto — el
        // panel salía de una línea aplastada (mordió en campo el primer día).
        let measured = label.cell?.cellSize(
            forBounds: NSRect(x: 0, y: 0, width: textWidth, height: .greatestFiniteMagnitude)
        ).height ?? 0
        let lineHeight = KaraokePanel.fontSize * 1.35 + KaraokePanel.lineSpacing
        let maxTextHeight = ceil(lineHeight * CGFloat(KaraokePanel.maxLines))
        // Piso de una línea real: aunque la medición fallara, el panel jamás
        // vuelve a verse como una rendija.
        let textHeight = min(max(ceil(measured), ceil(lineHeight)), maxTextHeight)
        let newHeight = textHeight + KaraokePanel.padding * 2

        var frame = panel.frame
        guard abs(frame.height - newHeight) > 0.5 else { return }
        let top = frame.maxY
        frame.size.height = newHeight
        frame.size.width = KaraokePanel.width
        frame.origin.y = top - newHeight
        // display:false — el label se repinta solo con el attributedStringValue.
        panel.setFrame(frame, display: true)

        label.frame = NSRect(
            x: KaraokePanel.padding,
            y: KaraokePanel.padding,
            width: textWidth,
            height: textHeight
        )
    }
}
