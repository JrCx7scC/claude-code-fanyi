// fanyi-apple: on-device language detection and translation for the fanyi translator server.
//
// A long-running helper that reads one JSON request per line on stdin and writes one JSON
// reply per line on stdout. Everything runs on this Mac: NaturalLanguage detects languages,
// and the Translation framework translates with the language packs installed in
// System Settings → General → Language & Region → Translation Languages.
//
//   {"id":1,"op":"detect","text":"..."}                        → {"id":1,"language":"es","confidence":0.92}
//   {"id":2,"op":"translate","from":"en","to":"zh-Hans","texts":["..."]} → {"id":2,"texts":["..."]}
//   {"id":3,"op":"status","from":"en","to":"zh-Hans"}           → {"id":3,"status":"installed"}
//
// Errors come back as {"id":n,"error":"..."}.
import Foundation
import NaturalLanguage
import Translation

struct Request: Decodable {
  let id: Int
  let op: String
  var text: String?
  var texts: [String]?
  var from: String?
  var to: String?
}

@main
struct FanyiApple {
  static func main() async {
    // One session per language pair, kept for the life of the process
    var sessions: [String: TranslationSession] = [:]
    let decoder = JSONDecoder()

    while let line = readLine(strippingNewline: true) {
      guard !line.isEmpty, let data = line.data(using: .utf8) else { continue }
      guard let req = try? decoder.decode(Request.self, from: data) else {
        reply(["id": NSNull(), "error": "bad request"])
        continue
      }
      do {
        switch req.op {
        case "detect":
          let recognizer = NLLanguageRecognizer()
          recognizer.processString(req.text ?? "")
          let best = recognizer.languageHypotheses(withMaximum: 1).first
          reply([
            "id": req.id,
            "language": best.map { $0.key.rawValue } ?? NSNull(),
            "confidence": best?.value ?? 0,
          ])

        case "status":
          let status = await LanguageAvailability().status(from: language(req.from), to: language(req.to))
          reply(["id": req.id, "status": describe(status)])

        case "translate":
          let from = language(req.from), to = language(req.to)
          let key = "\(req.from ?? "")>\(req.to ?? "")"
          let status = await LanguageAvailability().status(from: from, to: to)
          guard status == .installed else {
            throw HelperError(
              status == .supported
                ? "The \(req.from ?? "?") → \(req.to ?? "?") language pack isn't downloaded. Add it in System Settings → General → Language & Region → Translation Languages."
                : "Apple Translation doesn't support \(req.from ?? "?") → \(req.to ?? "?").")
          }
          let session = sessions[key] ?? TranslationSession(installedSource: from, target: to)
          sessions[key] = session
          let texts = req.texts ?? []
          // Blank segments are passed through; the rest go in one batch
          let indices = texts.indices.filter { !texts[$0].trimmingCharacters(in: .whitespaces).isEmpty }
          var out = texts
          if !indices.isEmpty {
            let requests = indices.map { TranslationSession.Request(sourceText: texts[$0], clientIdentifier: String($0)) }
            for response in try await session.translations(from: requests) {
              if let id = response.clientIdentifier, let i = Int(id) { out[i] = response.targetText }
            }
          }
          reply(["id": req.id, "texts": out])

        default:
          throw HelperError("unknown op: \(req.op)")
        }
      } catch {
        reply(["id": req.id, "error": String(describing: error)])
      }
    }
  }

  static func language(_ tag: String?) -> Locale.Language {
    Locale.Language(identifier: tag ?? "en")
  }

  static func describe(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unknown"
    }
  }

  static func reply(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
      let line = String(data: data, encoding: .utf8)
    else { return }
    print(line)
    fflush(stdout)
  }
}

struct HelperError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}
