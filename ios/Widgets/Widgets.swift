// Home and lock screen widgets: Today (the things, what's next, dinner) and a list (Groceries first), each asking the
// tablet itself through the relay with this phone's key (Glance.fetch), and ticking off on the list widget.
import AppIntents
import SwiftUI
import WidgetKit

struct Entry: TimelineEntry { var date: Date; var glance: Glance?; var paired: Bool }

struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> Entry { Entry(date: Date(), glance: .sample, paired: true) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    if context.isPreview { return completion(placeholder(in: context)) }
    completion(Entry(date: Date(), glance: Glance.load(), paired: PairingStore.load() != nil))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    Task {
      let g = await Glance.fetch()
      let e = Entry(date: Date(), glance: g, paired: PairingStore.load() != nil)
      completion(Timeline(entries: [e], policy: .after(Date().addingTimeInterval(20 * 60))))
    }
  }
}

// ---- Today ----
struct TodayView: View {
  var entry: Entry
  @Environment(\.widgetFamily) var family
  var body: some View {
    if let g = entry.glance {
      switch family {
      case .accessoryRectangular:
        VStack(alignment: .leading, spacing: 1) {
          if let t = g.things.first { Text(t).font(.headline).lineLimit(1) }
          ForEach(g.next.prefix(g.things.isEmpty ? 2 : 1), id: \.self) { e in Text("\(when(e)) \(e.title)").lineLimit(1) }
          if g.things.isEmpty && g.next.isEmpty { Text("Nothing next").foregroundStyle(.secondary) }
        }
      case .accessoryInline:
        Text(g.things.first ?? g.next.first.map { "\(when($0)) \($0.title)" } ?? "Nothing next")
      default:
        VStack(alignment: .leading, spacing: 6) {
          Text(Date(), format: .dateTime.weekday(.wide).day()).font(.caption).foregroundStyle(.secondary)
          ForEach(g.things.prefix(family == .systemSmall ? 1 : 2), id: \.self) { t in Text(t).font(.subheadline.weight(.semibold)).lineLimit(2) }
          ForEach(g.next.prefix(family == .systemSmall ? 2 : 3), id: \.self) { e in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(when(e)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
              Text(e.title).font(.subheadline).lineLimit(1)
            }
          }
          if g.next.isEmpty && g.things.isEmpty { Text("Nothing on the calendar.").font(.subheadline).foregroundStyle(.secondary) }
          Spacer(minLength: 0)
          if family != .systemSmall, let d = g.dinner { Text("Dinner  \(d)").font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      Text(entry.paired ? "Not in touch with home yet." : "Open OpenHouse to join your home.").font(.caption).foregroundStyle(.secondary)
    }
  }
  func when(_ e: Glance.Event) -> String {
    if e.allDay { return "All day" }
    if e.start <= Date() { return "Now" }
    let cal = Calendar.current
    let t = e.start.formatted(date: .omitted, time: .shortened)
    return cal.isDateInToday(e.start) ? t : cal.isDateInTomorrow(e.start) ? "Tmrw \(t)" : t
  }
}

struct TodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "today", provider: Provider()) { e in
      TodayView(entry: e).containerBackground(.background, for: .widget).widgetURL(URL(string: "openhouse://tab/today"))
    }
    .configurationDisplayName("Today")
    .description("What's next at home.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
  }
}

// ---- a list ----
struct CheckItem: AppIntent {
  static var title: LocalizedStringResource = "Tick off"
  static var isDiscoverable = false
  @Parameter(title: "List") var list: String
  @Parameter(title: "Item") var item: String
  init() {}
  init(list: String, item: String) { self.list = list; self.item = item }
  func perform() async throws -> some IntentResult {
    guard let p = PairingStore.load() else { return .result() }
    // Gone from the widget at once; home gets it through the relay.
    if var g = Glance.load(), let i = g.lists.firstIndex(where: { $0.id == list }) { g.lists[i].items.removeAll { $0.id == item }; g.save() }
    let t = Tablet(p); defer { t.close() }
    _ = try? await t.request("POST", "/house/list", ["list": list, "check": [item]])
    return .result()
  }
}

struct ListView: View {
  var entry: Entry
  @Environment(\.widgetFamily) var family
  var body: some View {
    if let l = entry.glance?.list("groceries") {
      let n = family == .systemLarge ? 12 : family == .systemMedium ? 5 : 4
      VStack(alignment: .leading, spacing: 5) {
        Text(l.name).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        if l.items.isEmpty { Text("Nothing to get.").font(.subheadline).foregroundStyle(.secondary) }
        ForEach(l.items.prefix(l.items.count > n ? n - 1 : n), id: \.self) { it in
          Button(intent: CheckItem(list: l.id, item: it.id)) {
            HStack(spacing: 8) {
              Image(systemName: "circle").font(.caption).foregroundStyle(.secondary)
              Text(it.text).font(.subheadline).lineLimit(1)
            }
          }.buttonStyle(.plain)
        }
        if l.items.count > n { Text("and \(l.items.count - n + 1) more").font(.caption).foregroundStyle(.secondary) }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      Text(entry.paired ? "Not in touch with home yet." : "Open OpenHouse to join your home.").font(.caption).foregroundStyle(.secondary)
    }
  }
}

struct ListWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "list", provider: Provider()) { e in
      ListView(entry: e).containerBackground(.background, for: .widget).widgetURL(URL(string: "openhouse://tab/lists"))
    }
    .configurationDisplayName("Groceries")
    .description("The list, ticked off right here.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

@main
struct OpenHouseWidgets: WidgetBundle {
  var body: some Widget { TodayWidget(); ListWidget() }
}
