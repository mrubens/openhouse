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

  /// The same household's tablet and this phone's place on it (what a new pairing would replace if not).
  func sameAs(_ o: Pairing) -> Bool { id == o.id && key == o.key && relay == o.relay }

  /// The clouds this app was built to take a pairing from: OPENHOUSE_CLOUD_HOSTS (Config/Base.xcconfig), through the
  /// app's Info.plist.
  static let cloudHosts: Set<String> = {
    let s = Bundle.main.object(forInfoDictionaryKey: "OpenHouseCloudHosts") as? String ?? ""
    let hosts = s.split(whereSeparator: { $0 == " " || $0 == "," }).map { $0.lowercased() }
    return hosts.isEmpty ? ["cloud.openhouse.computer"] : Set(hosts)
  }()

  /// Whether a pairing may come from this address: https on one of the app's clouds, or (debug builds only) plain
  /// http to this computer, a local cloud while developing.
  static func fromCloud(_ url: URL) -> Bool {
    guard let host = url.host?.lowercased(), url.user == nil, url.password == nil else { return false }
    if url.scheme == "https" { return cloudHosts.contains(host) && (url.port == nil || url.port == 443) }
    #if DEBUG
    if url.scheme == "http" { return ["localhost", "127.0.0.1"].contains(host) }
    #endif
    return false
  }

  /// From the cloud page's address, as the Wi-Fi page hands over to it after joining (phone.jsx cloudLink). Only from
  /// the app's own clouds: any other page could otherwise swap this phone onto a home of its choosing.
  static func from(url: URL) -> Pairing? {
    guard let frag = url.fragment, let page = cloudPage(url) else { return nil }
    return from(fragment: frag, page: page)
  }

  /// The household's page in one of the app's clouds (its /h/ address, without the query or what's after #).
  static func cloudPage(_ url: URL) -> String? {
    guard fromCloud(url) else { return nil }
    var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
    c?.fragment = nil; c?.query = nil
    guard let page = c?.string, page.contains("/h/") || page.hasSuffix("/h") else { return nil }
    return page
  }

  /// <id>.<key>.<relay id>.<relay token>.<about>, for the household whose cloud page is `page`.
  static func from(fragment frag: String, page: String) -> Pairing? {
    let parts = frag.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    let ok = { (s: String) in !s.isEmpty && s.count <= 2000 && s.allSatisfy { $0.isLetter && $0.isASCII || $0.isNumber || $0 == "_" || $0 == "-" } }
    guard parts.count == 5, parts.allSatisfy(ok), parts[1].count == 43, B64.dec(parts[1])?.count == 32 else { return nil }
    return Pairing(id: parts[0], key: parts[1], relay: parts[2], token: parts[3], about: parts[4], page: page, relayURL: nil)
  }

  /// An invite to join through the cloud (phone.jsx Invite: the cloud page, ?for=, #<pair>.<key>.<relay id>): the
  /// cloud page it names and the app's own page to join with.
  static func invite(_ url: URL) -> (page: String, join: URL)? {
    guard let frag = url.fragment, let page = cloudPage(url),
          frag.range(of: #"^[\w-]{1,200}\.[\w-]{43}\.[\w-]{1,200}$"#, options: .regularExpression) != nil else { return nil }
    var c = URLComponents(string: "openhouse-app://phone/h/")
    if let who = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "for" })?.value {
      c?.queryItems = [URLQueryItem(name: "for", value: String(who.prefix(80)))]
    }
    c?.fragment = frag
    return c?.url.map { (page, $0) }
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
