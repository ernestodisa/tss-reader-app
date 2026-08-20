import Carbon.HIToolbox
import Foundation

/// Hotkey global vía RegisterEventHotKey de Carbon: NO requiere permiso de
/// Accesibilidad (a diferencia de NSEvent.addGlobalMonitor) y el sistema
/// entrega el evento aunque la app sea agente sin foco.
///
/// Default ⌃⌥⌘F ("Folio"): los combos solo-⌘/⌘⌥ se los comen las apps
/// (⌘⌥L = Descargas en Safari — mordió en campo con la v0).
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let callback: () -> Void

    init?(keyCode: UInt32 = UInt32(kVK_ANSI_F),
          modifiers: UInt32 = UInt32(controlKey | optionKey | cmdKey),
          callback: @escaping () -> Void) {
        self.callback = callback

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData -> OSStatus in
                guard let userData else { return noErr }
                Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue().callback()
                return noErr
            },
            1, &eventType, selfPtr, &handlerRef
        )
        guard installed == noErr else { return nil }

        let hotKeyID = EventHotKeyID(signature: OSType(0x464C_4941) /* 'FLIA' */, id: 1)
        let registered = RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                                             GetApplicationEventTarget(), 0, &ref)
        guard registered == noErr else {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            return nil
        }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
