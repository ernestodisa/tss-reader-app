import Foundation

/// Convivencia con la v0: si el Quick Action / CLI dejó una lectura sonando,
/// la calla antes de que el menubar hable encima. Espejo de stopRunning() del
/// CLI, con la MISMA verificación de línea de comando: los pid se reciclan y
/// un pidfile huérfano podría apuntar a cualquier otro proceso de la máquina.
enum CLIGuard {
    private static let stateDir = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".cache/folio-say")

    /// Marcas que solo aparecen en procesos lanzados por el CLI v0.
    private static var chunkMark: String { stateDir.appendingPathComponent("chunk-").path }
    private static let bundleMark = "folio-say.mjs"

    static func stopCLIPlayback() {
        killIfOurs(pidfile: stateDir.appendingPathComponent("afplay.pid"), mark: chunkMark)
        killIfOurs(pidfile: stateDir.appendingPathComponent("folio-say.pid"), mark: bundleMark)
    }

    private static func killIfOurs(pidfile: URL, mark: String) {
        guard let raw = try? String(contentsOf: pidfile, encoding: .utf8),
              let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 1
        else { return }
        if processCommand(pid: pid)?.contains(mark) == true {
            kill(pid, SIGTERM)
        }
        try? FileManager.default.removeItem(at: pidfile)
    }

    /// Línea de comando completa vía /bin/ps (ruta absoluta, como el CLI).
    private static func processCommand(pid: Int32) -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ww", "-p", String(pid), "-o", "command="]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
        } catch { return nil }
        guard task.terminationStatus == 0 else { return nil }  // pid no existe
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
