import AppKit
import ApplicationServices

/// Captura el texto seleccionado de la app frontal simulando ⌘C y leyendo el
/// pasteboard, restaurando después su contenido previo (best-effort, texto).
///
/// Requiere permiso de Accesibilidad (postear eventos de teclado); la ruta de
/// Servicios del Quick Action v0 no lo necesita, pero un menubar con hotkey
/// global sí — es el costo de leer la selección sin que el usuario copie a mano.
enum SelectionCapture {
    /// Pide el permiso (con diálogo del sistema la primera vez).
    @discardableResult
    static func ensureAccessibility(prompt: Bool) -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    /// Devuelve la selección, o nil si no hay (o no hubo permiso). Síncrono con
    /// espera corta: se llama desde el handler del hotkey.
    static func grabSelection() -> String? {
        guard ensureAccessibility(prompt: true) else { return nil }

        let pasteboard = NSPasteboard.general
        let before = pasteboard.changeCount
        let saved = pasteboard.string(forType: .string)

        // ⌘C sintético a la app frontal (keycode 8 = 'c' en layout ANSI).
        guard let src = CGEventSource(stateID: .combinedSessionState),
              let down = CGEvent(keyboardEventSource: src, virtualKey: 8, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 8, keyDown: false)
        else { return nil }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)

        // Esperar a que la app frontal procese el copy (hasta ~600 ms).
        var copied: String?
        for _ in 0..<30 {
            usleep(20_000)
            if pasteboard.changeCount != before {
                copied = pasteboard.string(forType: .string)
                break
            }
        }

        // Restaurar el pasteboard anterior (solo si capturamos algo nuevo:
        // si el copy no surtió efecto, el pasteboard sigue intacto).
        if copied != nil {
            pasteboard.clearContents()
            if let saved { pasteboard.setString(saved, forType: .string) }
        }

        let text = copied?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (text?.isEmpty == false) ? text : nil
    }

    /// Fallback sin Accesibilidad: leer el portapapeles tal cual.
    static func clipboardText() -> String? {
        let text = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (text?.isEmpty == false) ? text : nil
    }
}
