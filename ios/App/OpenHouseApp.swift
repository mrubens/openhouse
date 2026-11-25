// OpenHouse on an iPhone (docs/iphone-app.md): the household's phone page from the cloud in a web view, so the app
// is always the page the tablet's household has, plus what a page can't do: notes by APNs, the share sheet, widgets
// and Siri. Joining is scanning the tablet's code here, which opens the tablet's own joining page in the web view.
import SwiftUI
import UserNotifications
import WidgetKit

@main
struct OpenHouseApp: App {
  @UIApplicationDelegateAdaptor(Delegate.self) var delegate
  @StateObject private var home = Home.shared
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      Group {
        if let url = home.url { WebPage(url: url).ignoresSafeArea() } // (the page keeps to the safe area itself: viewport-fit=cover)
        else { JoinView() }
      }
      .onOpenURL { home.open($0) }
      .onChange(of: phase) { _, p in if p == .active { WidgetCenter.shared.reloadAllTimelines() } }
    }
  }
}

/// What the app shows: the web page to load (the household's, or a tablet's joining page while joining).
@MainActor final class Home: ObservableObject {
  static let shared = Home()
  @Published var url: URL?
  @Published var pairing: Pairing?
  /// Asked of the page that's showing (a tab to switch to); WebPage runs it.
  @Published var script: String?

  init() {
    pairing = PairingStore.load()
    url = ProcessInfo.processInfo.environment["OPENHOUSE_JOIN"].flatMap(URL.init(string:)) ?? pairing?.pageURL
  }

  /// A link from the tablet's code (scanned or pasted): its joining page, or the cloud page with a pairing.
  func join(_ u: URL) {
    if let p = Pairing.from(url: u) { Task { await paired(p) } } else { url = u }
  }

  /// The page has joined (it went on to the cloud's copy with the pairing after #): keep it, and set up notes. One that
  /// would replace this phone's pairing with another is kept only if the person says so; false when they don't.
  @discardableResult
  func paired(_ p: Pairing) async -> Bool {
    if let old = pairing, !old.sameAs(p), !(await Home.askToReplace()) { return false }
    let first = pairing?.id != p.id || pairing?.key != p.key
    var p = p
    if !first, let r = pairing?.relayURL { p.relayURL = r }
    if first || pairing != p { PairingStore.save(p); pairing = p }
    if url == nil || first { url = p.pageURL }
    if first {
      WidgetCenter.shared.reloadAllTimelines()
      Task { await Notes.turnOn(p) }
    }
    return true
  }

  /// Asks the person, natively, before this phone leaves the home it's joined to for another one.
  private static func askToReplace() async -> Bool {
    guard let top = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController }).first
    else { return false }
    var shown = top
    while let next = shown.presentedViewController { shown = next }
    if shown is UIAlertController { return false } // (already asking: a page asking again and again gets one question)
    return await withCheckedContinuation { done in
      let a = UIAlertController(title: "Join another home?",
                                message: "This page wants this phone to join a different home. It would stop being joined to the one it's on now.",
                                preferredStyle: .alert)
      a.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in done.resume(returning: false) })
      a.addAction(UIAlertAction(title: "Join it", style: .destructive) { _ in done.resume(returning: true) })
      shown.present(a, animated: true)
    }
  }

  /// This phone was removed on the tablet (the page says so): forget the pairing.
  func removed() { PairingStore.save(nil); pairing = nil; url = nil; WidgetCenter.shared.reloadAllTimelines() }

  /// openhouse://tab/<tab> from a widget: today, or one of the household's apps on the phone's bar (its id, as lists);
  /// the page goes to Home when there's no such tab.
  func open(_ u: URL) {
    guard u.scheme == "openhouse" else { return }
    if u.host == "tab", let tab = u.pathComponents.last, tab.range(of: #"^[\w-]{1,40}$"#, options: .regularExpression) != nil {
      script = "localStorage.setItem('openhouse.phone.tab', JSON.stringify('\(tab)')); location.reload();"
    }
  }

  func openNote(_ open: String) {
    guard let p = pairing, open.range(of: #"^opie:[\w-]{1,40}$"#, options: .regularExpression) != nil,
          var c = URLComponents(string: p.page) else { return }
    c.queryItems = [URLQueryItem(name: "open", value: open)]
    c.fragment = "\(p.id).\(p.key).\(p.relay).\(p.token).\(p.about)"
    url = c.url
  }
}
