// A note from home arrives sealed (the tablet seals it with this phone's note key; the cloud and Apple pass it on
// unopened, bridge/screens.js notify). This opens it on the phone and shows its words.
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  override func didReceive(_ request: UNNotificationRequest, withContentHandler done: @escaping (UNNotificationContent) -> Void) {
    let c = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    guard let p = PairingStore.load(), let s = c.userInfo["s"] as? String, let box = B64.dec(s),
          let opened = Seal.open(Seal.noteKey(p.keyData), aad: "note:\(p.id)", box),
          let note = (try? JSONSerialization.jsonObject(with: opened)) as? [String: Any] else {
      c.title = "Opie"; c.body = "Something from home."
      return done(c)
    }
    c.title = note["title"] as? String ?? "Opie"
    // (Plain words: the tablet's UI blocks and markdown's marks left out, as the page shows them.)
    c.body = (note["body"] as? String ?? "").replacingOccurrences(of: #"```[\s\S]*?(```|$)"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"\*\*|__|`"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    if let tag = note["tag"] as? String { c.threadIdentifier = tag }
    var info = c.userInfo
    info.removeValue(forKey: "s")
    if let open = note["open"] as? String { info["open"] = open }
    c.userInfo = info
    c.sound = .default
    done(c)
  }
}
