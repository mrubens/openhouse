// "Hey Siri, ask Opie…" and a Shortcuts action: a typed turn to Opie as this phone's person (POST /chat, the
// same as the page's Ask sheet), answered out loud by Siri.
import AppIntents

struct AskOpie: AppIntent {
  static var title: LocalizedStringResource = "Ask Opie"
  static var description = IntentDescription("Ask Opie at home: about the day, or to add to a list or the calendar.")
  @Parameter(title: "What to ask", requestValueDialog: "What should I ask Opie?") var text: String

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let p = PairingStore.load() else { return .result(dialog: "Open Opie and join your home first.") }
    guard p.canAsk else { return .result(dialog: "This phone can't ask Opie.") }
    let t = Tablet(p); defer { t.close() }
    var body: [String: Any] = ["text": text]
    if !p.person.isEmpty { body["who"] = p.person }
    guard let r = try? await t.request("POST", "/chat", body), r.status == 200 else { return .result(dialog: "Home didn't answer. Try again in a moment.") }
    // The answer streams as lines ({type: delta|reset|done}); Siri says the whole of it.
    var said = "", done: String?
    for line in String(decoding: r.body, as: UTF8.self).split(separator: "\n") {
      guard let ev = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
      switch ev["type"] as? String {
      case "delta": said += ev["text"] as? String ?? ""
      case "reset": said = ""
      case "done": done = ev["text"] as? String
      default: break
      }
    }
    let answer = (done?.isEmpty == false ? done! : said).replacingOccurrences(of: #"```[\s\S]*?```|[*_#`]"#, with: "", options: .regularExpression)
    return .result(dialog: IntentDialog(stringLiteral: answer.isEmpty ? "No answer came back." : answer))
  }
}

struct Phrases: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: AskOpie(), phrases: ["Ask \(.applicationName)", "Tell \(.applicationName)"],
                shortTitle: "Ask Opie", systemImageName: "bubble.left")
  }
}
