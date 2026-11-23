// Requests to the household's tablet as this phone, through the cloud's relay: the same sealed requests and replies as
// the phone page's (chat/src/screen-client.js, relay-client.js; bridge/screens.js on the tablet). The relay passes
// the bytes on unopened; only this phone and the tablet hold the key.
import Foundation

enum TabletError: Error { case notPaired, refused(String), removed, cutOff, status(Int), noRelay }

struct Reply {
  var status: Int
  var body: Data
  var json: [String: Any]? { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] }
}

final class Tablet {
  let p: Pairing
  private let key: Data
  private var task: URLSessionWebSocketTask?
  private static var last: Int64 = 0
  private static let lock = NSLock()

  init(_ p: Pairing) { self.p = p; key = p.keyData }

  /// The relay's address: kept with the pairing, else read from the household's page (its openhouse-relay meta).
  static func relayURL(for p: Pairing) async throws -> URL {
    if let s = p.relayURL, let u = URL(string: s) { return u }
    guard let page = URL(string: p.page) else { throw TabletError.noRelay }
    let (d, _) = try await URLSession.shared.data(from: page)
    let html = String(decoding: d, as: UTF8.self)
    guard let r = html.range(of: #"<meta name="openhouse-relay" content="([^"]+)""#, options: .regularExpression) else { throw TabletError.noRelay }
    let tag = String(html[r]), v = tag.components(separatedBy: "content=\"")[1].dropLast()
    guard let u = URL(string: String(v).replacingOccurrences(of: "&amp;", with: "&")) else { throw TabletError.noRelay }
    var np = p; np.relayURL = u.absoluteString
    if PairingStore.load()?.id == p.id { PairingStore.save(np) }
    return u
  }

  /// Counters only go up: microseconds of this phone's clock (the page counts the same way, so the app, the page and
  /// the extensions share one window on the tablet), with a little chance so two at once don't meet.
  private static func next() -> Int64 {
    lock.lock(); defer { lock.unlock() }
    let n = max(Int64(Date().timeIntervalSince1970 * 1000) * 1000 + Int64.random(in: 0..<1000), last + 1)
    last = n
    return n
  }

  private func connect() async throws -> URLSessionWebSocketTask {
    if let task, task.state == .running { return task }
    let url = try await Tablet.relayURL(for: p)
    let t = URLSession.shared.webSocketTask(with: url)
    t.resume()
    try await t.send(.string(Tablet.json(["t": "hello", "role": "device", "relay": p.relay, "token": p.token])))
    while true {
      let m = try await Tablet.read(t)
      if m["t"] as? String == "ok" { break }
      if m["t"] as? String == "no" { t.cancel(); throw TabletError.refused(m["why"] as? String ?? "refused") }
    }
    task = t
    return t
  }

  func close() { task?.cancel(with: .normalClosure, reason: nil); task = nil }

  /// One request (GET or POST with a JSON body), answered whole.
  func request(_ method: String, _ path: String, _ body: Any? = nil, again: Bool = true) async throws -> Reply {
    let n = Tablet.next()
    var msg: [String: Any] = ["n": n, "m": method, "p": path]
    if let body { msg["b"] = body }
    let box = Seal.seal(key, aad: "req:\(p.id)", try JSONSerialization.data(withJSONObject: msg))
    guard box.count <= 64 * 1024 else { throw TabletError.status(413) }
    let t = try await connect()
    let rid = String(n, radix: 36) + String(Int.random(in: 0..<1_000_000), radix: 36)
    var i = 0, at = 0, part = 0
    repeat {
      let chunk = box.subarray(at, min(at + 16 * 1024, box.count)); at += 16 * 1024
      var m: [String: Any] = ["t": "req", "rid": rid, "k": "s", "id": p.id, "i": part, "d": B64.enc(chunk)]
      if at < box.count { m["more"] = 1 }
      try await t.send(.string(Tablet.json(m)))
      part += 1
    } while at < box.count

    // The relay may pass a reply's messages on out of order: each has its place (i).
    var status: Int?, early: [Int: [String: Any]] = [:], sealed = Data(), done = false
    while !done {
      let m = try await Tablet.read(t)
      guard m["t"] as? String == "res", m["rid"] as? String == rid else { continue }
      let take = { (x: [String: Any]) in
        if let s = x["s"] as? Int, status == nil { status = s }
        if let d = x["d"] as? String, let b = B64.dec(d) { sealed.append(b) }
        if x["e"] != nil { done = true }
      }
      guard let place = m["i"] as? Int else { take(m); continue }
      early[place] = m
      while let x = early.removeValue(forKey: i) { i += 1; take(x) }
    }
    let s = status ?? 200
    if s == 401 { if again { try await Task.sleep(nanoseconds: 2_000_000_000); return try await request(method, path, body, again: false) }; throw TabletError.removed }
    if s == 409 && again { return try await request(method, path, body, again: false) }
    guard s == 200 else { throw TabletError.status(s) }
    return try open(sealed, n: n)
  }

  /// The tablet's reply: frames of [4-byte length][box], the first its head, then the body, then an end.
  private func open(_ d: Data, n: Int64) throws -> Reply {
    var at = d.startIndex, i = 0, head: [String: Any]?, body = Data(), ended = false
    while at + 4 <= d.endIndex {
      let len = d[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
      guard at + 4 + len <= d.endIndex else { break }
      guard let opened = Seal.open(key, aad: "res:\(p.id):\(n):\(i)", Data(d[at + 4..<at + 4 + len])), let type = opened.first else { throw TabletError.cutOff }
      at += 4 + len; i += 1
      let data = opened.dropFirst()
      if type == 0 { head = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
      else if type == 1 { body.append(data) }
      else if type == 2 { ended = true }
    }
    guard let head, ended else { throw TabletError.cutOff }
    return Reply(status: head["status"] as? Int ?? 0, body: body)
  }

  private static func json(_ o: [String: Any]) -> String { String(decoding: (try? JSONSerialization.data(withJSONObject: o)) ?? Data(), as: UTF8.self) }
  private static func read(_ t: URLSessionWebSocketTask) async throws -> [String: Any] {
    switch try await t.receive() {
    case .string(let s): return (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
    case .data(let d): return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    @unknown default: return [:]
    }
  }
}

extension Data {
  func subarray(_ a: Int, _ b: Int) -> Data { Data(self[(startIndex + a)..<(startIndex + b)]) }
}
