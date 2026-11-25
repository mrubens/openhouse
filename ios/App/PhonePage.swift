// The household's phone page as this app carries it: built from chat/src/phone.jsx into the app when it's built
// (chat/phone-page.mjs, the PhonePage folder in the app), and served here from the app's own address,
// openhouse-app://phone/h/. So the code that holds this phone's key is the code Apple signed, never a copy a server
// could change (the cloud's /h/ copy stays for phones in a browser). The page is the cloud's copy otherwise: told where
// the relay is (its openhouse-relay meta), it reaches the tablet only through the relay, and every request is sealed
// with the phone's key. The one thing it fetches from the cloud, a big reply's box (relay-client.js), the app fetches
// for it (still sealed), so the page itself reaches nothing but the relay.
//
// Why a scheme handler and not loadFileURL: a file page has the "null" origin, so storage, the frames' rules
// (frame-ancestors, script-src by address) and the page's own checks of its address don't hold; here the page has an
// origin of its own, with the same rules as the cloud gives its copy.
import Foundation
import WebKit

enum PhonePage {
  static let scheme = "openhouse-app"
  static let origin = "\(scheme)://phone"
  /// The page, with the pairing after # (the page reads it there, as the cloud copy's).
  static func url(_ p: Pairing, query: [URLQueryItem] = []) -> URL? {
    var c = URLComponents(string: "\(origin)/h/")
    if !query.isEmpty { c?.queryItems = query }
    c?.fragment = "\(p.id).\(p.key).\(p.relay).\(p.token).\(p.about)"
    return c?.url
  }
  static func isPage(_ u: URL) -> Bool { u.scheme == scheme && u.host == "phone" }

  /// The page's rules: the same as the cloud's /h/ (openhouse-cloud app.ts phonePage), with the relay the only place
  /// it may connect to.
  static func pageRules(relay: URL) -> String {
    let r = relayOrigin(relay)
    return "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src \(r) 'self'; manifest-src 'none'; worker-src 'none'; img-src 'self' data: blob: https:; frame-src \(origin); form-action 'none'; frame-ancestors 'none'"
  }

  /// An app's frame: as the cloud's (app.ts appFrame), framed only by this page, its scripts only from here, and it
  /// reaches only the hosts the tablet lets the app reach (?r=, named by the page).
  static func frameRules(reaches r: String?) -> String {
    let hosts = Array(Set((r ?? "").lowercased().split(separator: ",").map(String.init)
      .filter { $0.count <= 120 && $0.range(of: #"^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*$"#, options: .regularExpression) != nil })).sorted().prefix(14)
    let reaches = hosts.map { "https://\($0)" }.joined(separator: " ")
    let more = reaches.isEmpty ? "" : " " + reaches
    let me = origin
    return "default-src 'none'; script-src \(me) blob: 'unsafe-eval'; style-src \(me) blob: 'unsafe-inline'; img-src \(me) blob: data:\(more); media-src blob: data:\(more); font-src \(me) blob: data:; worker-src blob:; connect-src \(reaches.isEmpty ? "'none'" : reaches); frame-src 'none'; object-src 'none'; form-action 'none'; base-uri https://app.invalid; frame-ancestors \(me)"
  }

  static func relayOrigin(_ u: URL) -> String {
    guard let s = u.scheme, let h = u.host else { return "'none'" }
    return "\(s)://\(h)\(u.port.map { ":\($0)" } ?? "")"
  }

  /// The page with the relay's address in it, as the cloud's copy has it.
  static func withRelay(_ page: String, _ relay: URL) -> String {
    let esc = relay.absoluteString.replacingOccurrences(of: "&", with: "&#38;").replacingOccurrences(of: "\"", with: "&#34;")
      .replacingOccurrences(of: "<", with: "&#60;").replacingOccurrences(of: ">", with: "&#62;")
    return page.replacingOccurrences(of: "<meta charset=\"utf-8\">", with: "<meta charset=\"utf-8\"><meta name=\"openhouse-relay\" content=\"\(esc)\">")
  }

  /// The box's key, as the relay names one (relay-box.ts): nothing else goes to the cloud.
  static func boxKey(_ u: URL) -> String? {
    guard u.path == "/v1/relay/box/out", let k = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "key" })?.value,
          k.count <= 200, k.range(of: #"^[\w./:-]+$"#, options: .regularExpression) != nil else { return nil }
    return k
  }
}

/// Serves openhouse-app://phone/: the page, its frame, the icon, and the box fetch.
final class PhonePageHandler: NSObject, WKURLSchemeHandler {
  private var live = Set<ObjectIdentifier>()
  private let lock = NSLock()

  static let files: URL? = Bundle.main.url(forResource: "PhonePage", withExtension: nil)

  func webView(_ v: WKWebView, start task: WKURLSchemeTask) {
    lock.withLock { _ = live.insert(ObjectIdentifier(task)) }
    let u = task.request.url ?? URL(string: "about:blank")!
    Task { @MainActor in
      let (status, type, rules, body) = await respond(u, task.request)
      var h = ["Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"]
      if let rules { h["Content-Security-Policy"] = rules }
      guard lock.withLock({ live.contains(ObjectIdentifier(task)) }),
            let r = HTTPURLResponse(url: u, statusCode: status, httpVersion: "HTTP/1.1", headerFields: h) else { return }
      task.didReceive(r)
      task.didReceive(body)
      task.didFinish()
      lock.withLock { _ = live.remove(ObjectIdentifier(task)) }
    }
  }

  func webView(_ v: WKWebView, stop task: WKURLSchemeTask) { lock.withLock { _ = live.remove(ObjectIdentifier(task)) } }

  private func file(_ name: String) -> Data? { Self.files.flatMap { try? Data(contentsOf: $0.appendingPathComponent(name)) } }
  private static let none = (404, "text/plain", nil as String?, Data())

  /// The relay this page reaches the tablet through: the pairing's (kept with it), or while joining by an invite, the
  /// one its cloud names.
  @MainActor private func relay() async -> URL? {
    if let p = Home.shared.pairing { return try? await Tablet.relayURL(for: p) }
    guard let page = Home.shared.invitePage else { return nil }
    return try? await Tablet.relayURL(for: Pairing(id: "", key: "", relay: "", token: "", about: "", page: page, relayURL: nil))
  }

  @MainActor private func respond(_ u: URL, _ req: URLRequest) async -> (Int, String, String?, Data) {
    guard PhonePage.isPage(u), req.httpMethod ?? "GET" == "GET" else { return Self.none }
    switch u.path {
    case "/h", "/h/":
      guard let d = file("index.html") else { return Self.none }
      guard let relay = await relay() else {
        return (503, "text/html; charset=utf-8", "default-src 'none'; style-src 'unsafe-inline'",
                Data(#"<!doctype html><meta name="viewport" content="width=device-width"><body style="font:17px -apple-system;padding:40px 24px;color:#555">The home can't be reached right now. Open the app again in a moment.</body>"#.utf8))
      }
      return (200, "text/html; charset=utf-8", PhonePage.pageRules(relay: relay), Data(PhonePage.withRelay(String(decoding: d, as: UTF8.self), relay).utf8))
    case "/h/frame.html":
      let r = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "r" })?.value
      return file("frame.html").map { (200, "text/html; charset=utf-8", PhonePage.frameRules(reaches: r), $0) } ?? Self.none
    case "/h/frame.js":
      let r = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "r" })?.value
      return file("frame.js").map { (200, "text/javascript; charset=utf-8", PhonePage.frameRules(reaches: r), $0) } ?? Self.none
    case "/h/icon.svg":
      return file("icon.svg").map { (200, "image/svg+xml", nil, $0) } ?? Self.none
    case "/v1/relay/box/out":
      // A big reply, sealed, from the cloud's relay box: fetched here so the page needs no way to the cloud.
      guard let p = Home.shared.pairing, let key = PhonePage.boxKey(u), let auth = req.value(forHTTPHeaderField: "Authorization"),
            auth == "Relay \(p.relay).\(p.token)", var c = URLComponents(string: p.origin) else { return Self.none }
      c.path = "/v1/relay/box/out"; c.queryItems = [URLQueryItem(name: "key", value: key)]
      guard let to = c.url else { return Self.none }
      var r = URLRequest(url: to); r.setValue(auth, forHTTPHeaderField: "Authorization")
      guard let (d, res) = try? await URLSession.shared.data(for: r), let h = res as? HTTPURLResponse else { return (502, "text/plain", nil, Data()) }
      return (h.statusCode, "application/octet-stream", nil, d)
    default:
      return Self.none
    }
  }
}
