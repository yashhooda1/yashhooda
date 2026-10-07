import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Thin wrapper over Apple's on-device language model (Foundation Models
/// framework, iOS 26+ on Apple Intelligence devices).
///
/// Both apps call this for summaries, so prompts and the user's notes never
/// leave the phone. On an older OS, or when Apple Intelligence is off, the
/// buttons that use it are hidden rather than falling back to a server.
enum OnDeviceAI {
    enum Failure: LocalizedError {
        case unavailable
        var errorDescription: String? {
            "On-device AI is not available. It needs iOS 26 or later with Apple Intelligence turned on."
        }
    }

    static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    static func respond(instructions: String, prompt: String) async throws -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                throw Failure.unavailable
            }
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: prompt)
            return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        #endif
        throw Failure.unavailable
    }
}
