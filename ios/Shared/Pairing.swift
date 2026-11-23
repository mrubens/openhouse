// This phone's pairing with its household's tablet: the same one the phone page keeps (chat/src/phone.jsx, the cloud
// copy's address after #: <id>.<key>.<relay id>.<relay token>.<about>). Kept in the keychain, shared with the app's
// extensions through the app group, readable after the phone's first unlock (widgets and notes run while it's locked).
import Foundation
import Security

let appGroup = "group.computer.openhouse.phone"

struct Pairing: Codable, Equatable {
  var id: String
  var key: String        // base64url, 32 bytes
  var relay: String      // the tablet's relay id
  var token: String      // this phone's relay token
  var about: String      // base64url JSON {person, scopes, kind}, as the page wrote it
  var page: String       // the household's page in the cloud, e.g. https://cloud.openhouse.computer/h/
  var relayURL: String?  // wss://… where the tablet is reached (the page's openhouse-relay meta)

  var keyData: Data { B64.dec(key) ?? Data() }
  var person: String { info["person"] as? String ?? "" }
  var scopes: [String] { info["scopes"] as? [String] ?? [] }
  var canAsk: Bool { scopes.contains("ask") }
  var canNotify: Bool { scopes.contains("notify") }
  private var info: [String: Any] {
    guard let d = B64.dec(about), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
    return j
  }

  /// The page's address with the pairing after # (never sent to the server: a fragment).
  var pageURL: URL? { URL(string: "\(page)#\(id).\(key).\(relay).\(token).\(about)") }
  /// The cloud's address (for /send).
  var origin: String { URL(string: page).flatMap { u in u.host.map { "\(u.scheme ?? "https")://\($0)\(u.port.map { ":\($0)" } ?? "")" } } ?? "" }

  /// From the cloud page's address, as the Wi-Fi page hands over to it after joining (phone.jsx cloudLink).
  static func from(url: URL) -> Pairing? {
    // https, or plain http only to this computer (a local cloud while developing).
    guard let frag = url.fragment, let scheme = url.scheme, scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")) else { return nil }
    let parts = frag.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    let ok = { (s: String) in !s.isEmpty && s.allSatisfy { $0.isLetter && $0.isASCII || $0.isNumber || $0 == "_" || $0 == "-" } }
    guard parts.count == 5, parts.allSatisfy(ok), parts[1].count == 43, B64.dec(parts[1])?.count == 32 else { return nil }
    var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
    c?.fragment = nil; c?.query = nil
    guard let page = c?.string, page.contains("/h/") || page.hasSuffix("/h") else { return nil }
    return Pairing(id: parts[0], key: parts[1], relay: parts[2], token: parts[3], about: parts[4], page: page, relayURL: nil)
  }
}

enum PairingStore {
  private static let service = "computer.openhouse.phone"
  private static let account = "pairing"

  private static func query(group: Bool) -> [String: Any] {
    var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    if group { q[kSecAttrAccessGroup as String] = appGroup }
    return q
  }

  static func load() -> Pairing? {
    for group in [true, false] {
      var q = query(group: group)
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: CFTypeRef?
      if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let p = try? JSONDecoder().decode(Pairing.self, from: d) { return p }
    }
    return nil
  }

  static func save(_ p: Pairing?) {
    for group in [true, false] { SecItemDelete(query(group: group) as CFDictionary) }
    guard let p, let d = try? JSONEncoder().encode(p) else { return }
    var q = query(group: true)
    q[kSecValueData as String] = d
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    // Without the app group's entitlement (an unsigned build), kept for the app alone.
    if SecItemAdd(q as CFDictionary, nil) == errSecMissingEntitlement {
      q.removeValue(forKey: kSecAttrAccessGroup as String)
      SecItemAdd(q as CFDictionary, nil)
    }
  }
}

/// Files shared by the app and its extensions (what the widgets last showed).
enum Shared {
  static var folder: URL {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  }
}
