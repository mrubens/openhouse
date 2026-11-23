// The household's phone page (chat/src/phone.jsx, the cloud's /h/ copy) in a web view. It's the same page as on the
// home screen, told it's in the app (window.openhouseApp), so it doesn't ask to be added to the home screen or to set up
// the Shortcut: the app does those things itself.
import SwiftUI
import WebKit

struct WebPage: UIViewRepresentable {
  var url: URL
  @ObservedObject private var home = Home.shared

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()
    cfg.allowsInlineMediaPlayback = true
    cfg.mediaTypesRequiringUserActionForPlayback = []
    let early = """
    window.openhouseApp = { platform: 'ios', version: 1 };
    try { localStorage.setItem('openhouse.phone.homeLater', 'true'); localStorage.setItem('openhouse.phone.shortcut', 'true'); } catch (e) {}
    """
    cfg.userContentController.addUserScript(WKUserScript(source: early, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let v = WKWebView(frame: .zero, configuration: cfg)
    v.navigationDelegate = context.coordinator
    v.uiDelegate = context.coordinator
    v.allowsBackForwardNavigationGestures = false
    v.scrollView.contentInsetAdjustmentBehavior = .never
    v.isOpaque = false
    v.backgroundColor = .systemBackground
    #if DEBUG
    v.isInspectable = true
    #endif
    v.load(URLRequest(url: url))
    context.coordinator.loaded = url
    return v
  }

  func updateUIView(_ v: WKWebView, context: Context) {
    if context.coordinator.loaded != url, v.url != url {
      context.coordinator.loaded = url
      v.load(URLRequest(url: url))
    }
    if let s = home.script {
      DispatchQueue.main.async { home.script = nil }
      v.evaluateJavaScript(s)
    }
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    var loaded: URL?

    func webView(_ v: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard let u = a.request.url else { return .cancel }
      if u.scheme == "openhouse" { await MainActor.run { Home.shared.open(u) }; return .cancel }
      // The joining page went on to the cloud's copy, with the pairing after #: keep it.
      if a.targetFrame?.isMainFrame != false, let p = Pairing.from(url: u) {
        await MainActor.run { Home.shared.paired(p); loaded = u }
        return .allow
      }
      // Within the page (its own address, the tablet's, its frames) stays here; a link out opens in Safari.
      let here = [v.url?.host, loaded?.host].compactMap { $0 }
      if a.targetFrame?.isMainFrame == false || here.contains(u.host ?? "") || u.scheme == "about" || u.scheme == "blob" || u.scheme == "data" { return .allow }
      if ["http", "https", "tel", "mailto", "maps", "shortcuts"].contains(u.scheme ?? "") { await UIApplication.shared.open(u) }
      return .cancel
    }

    // target=_blank: open outside.
    func webView(_ v: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures w: WKWindowFeatures) -> WKWebView? {
      if let u = a.request.url { UIApplication.shared.open(u) }
      return nil
    }

    // Talking to Opie: the microphone, for the household's own page only (the system asks the person first).
    func webView(_ v: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
      f.isMainFrame && type == .microphone && origin.host == loaded?.host ? .grant : .deny
    }

    func webViewWebContentProcessDidTerminate(_ v: WKWebView) { v.reload() }
  }
}
