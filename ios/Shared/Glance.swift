// What the widgets show, made from the tablet's GET /house as the phone page's Today makes it (chat/src/phone.jsx):
// the things strip, the next events, dinner, this person's chores, and a list. The last one is kept in the app
// group, so a widget shows something when home isn't reachable.
import Foundation

struct Glance: Codable {
  struct Event: Codable, Hashable { var title: String; var start: Date; var allDay: Bool; var who: [String] }
  struct Item: Codable, Hashable { var id: String; var text: String }
  struct List: Codable, Hashable { var id: String; var name: String; var items: [Item] }

  var at: Date
  var person: String
  var things: [String]
  var next: [Event]
  var dinner: String?
  var chores: [String]
  var lists: [List]

  static let sample = Glance(at: Date(), person: "Sam", things: ["Swim in 15 minutes"],
    next: [Event(title: "Dentist", start: Date().addingTimeInterval(3600), allDay: false, who: ["Sam"]),
           Event(title: "Book club", start: Date().addingTimeInterval(4 * 3600), allDay: false, who: ["Alex"])],
    dinner: "Tacos", chores: ["Feed Pepper"],
    lists: [List(id: "groceries", name: "Groceries", items: [Item(id: "1", text: "Milk"), Item(id: "2", text: "Eggs"), Item(id: "3", text: "Apples")])])

  func list(_ id: String) -> List? { lists.first { $0.id == id } ?? lists.first }

  // ---- from the house ----
  static func from(house h: [String: Any], person: String, now: Date = Date()) -> Glance {
    let iso = ISO8601DateFormatter(), isoMs = ISO8601DateFormatter()
    isoMs.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let day = DateFormatter(); day.dateFormat = "yyyy-MM-dd"; day.timeZone = .current
    func date(_ v: Any?) -> Date? {
      guard let s = v as? String else { return nil }
      return isoMs.date(from: s) ?? iso.date(from: s) ?? (s.count == 10 ? day.date(from: s) : nil)
    }
    let mine = { (who: Any?) in (who as? String)?.lowercased() == person.lowercased() }
    let today = day.string(from: now)

    let things = (h["things"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.prefix(3)
    let events: [Event] = (h["events"] as? [[String: Any]] ?? []).compactMap { e in
      guard let start = date(e["start"]) else { return nil }
      let end = date(e["end"]) ?? start, allDay = e["allDay"] as? Bool ?? false
      guard end > now, start < now.addingTimeInterval(36 * 3600), !allDay || day.string(from: start) == today else { return nil }
      let who = ([e["who"]] + (e["also"] as? [Any] ?? [])).compactMap { $0 as? String }.filter { !$0.isEmpty }
      return Event(title: e["title"] as? String ?? "", start: start, allDay: allDay, who: who)
    }.sorted { $0.start < $1.start }
    let meals = h["meals"] as? [String: Any], dinner = (meals?[today] as? [String: Any])?["dinner"] as? String
    let chores = (h["chores"] as? [[String: Any]] ?? []).filter {
      ($0["today"] as? Bool ?? false) && !($0["done"] as? Bool ?? false) && !($0["skipped"] as? Bool ?? false) && mine($0["who"])
    }.compactMap { $0["task"] as? String }
    let lists: [List] = (h["lists"] as? [[String: Any]] ?? []).compactMap { l in
      guard let id = l["id"] as? String else { return nil }
      let items = (l["items"] as? [[String: Any]] ?? []).filter { !($0["done"] as? Bool ?? false) }
        .compactMap { i in (i["text"] as? String).map { Item(id: i["id"] as? String ?? $0, text: $0) } }
      return List(id: id, name: l["name"] as? String ?? id.capitalized, items: items)
    }
    return Glance(at: now, person: person, things: Array(things), next: Array(events.prefix(4)), dinner: dinner, chores: chores, lists: lists)
  }

  // ---- kept for the widgets ----
  private static var file: URL { Shared.folder.appendingPathComponent("glance.json") }
  static func load() -> Glance? { (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Glance.self, from: $0) } }
  func save() { try? JSONEncoder().encode(self).write(to: Glance.file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }

  /// Asks home for the house now (through the relay), keeps it, and answers it; the last one kept when home doesn't answer.
  static func fetch() async -> Glance? {
    guard let p = PairingStore.load() else { return nil }
    let t = Tablet(p)
    defer { t.close() }
    do {
      let r = try await t.request("GET", "/house")
      guard r.status == 200, let h = r.json else { return load() }
      let g = from(house: h, person: p.person)
      g.save()
      return g
    } catch { return load() }
  }
}
