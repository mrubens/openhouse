// The household's phone page (chat/src/phone.jsx, the app's own copy: PhonePage.swift) in a web view. It's the same page as on the
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
    cfg.setURLSchemeHandler(PhonePageHandler(), forURLScheme: PhonePage.scheme)
    cfg.allowsInlineMediaPlayback = true
    cfg.mediaTypesRequiringUserActionForPlayback = []
    let early = """
    window.openhouseApp = { platform: 'ios', version: 1 };
    try { localStorage.setItem('openhouse.phone.homeLater', 'true'); localStorage.setItem('openhouse.phone.shortcut', 'true'); } catch (e) {}
    """
    cfg.userContentController.addUserScript(WKUserScript(source: early, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    #if DEBUG
    // The voice session's own log, here in the app's log (Console, or simctl's).
    let debug = """
    const post = (s) => { try { webkit.messageHandlers.log.postMessage(s); } catch (e) {} };
    addEventListener('error', (e) => post('error ' + e.message)); addEventListener('unhandledrejection', (e) => post('rejected ' + e.reason));
    document.addEventListener('securitypolicyviolation', (e) => post('csp ' + e.violatedDirective + ' ' + e.blockedURI));
    post('at ' + location.protocol + '//' + location.host + location.pathname + ' secure=' + isSecureContext + ' subtle=' + !!(crypto && crypto.subtle));
    globalThis.OPENHOUSE_LIVE_DEBUG = true; const d = console.debug; console.debug = (...a) => { try { webkit.messageHandlers.log.postMessage(a.map(String).join(' ')); } catch (e) {} d.apply(console, a); };
    const W = WebSocket; globalThis.WebSocket = function (u, p) { const s = new W(u, p); s.addEventListener('message', (e) => { const t = String(e.data); if (t.startsWith('{"t":"no"')) console.debug('[relay] ' + t); }); s.addEventListener('close', (e) => console.debug('[relay] closed ' + e.code)); return s; }; Object.assign(globalThis.WebSocket, W); globalThis.WebSocket.prototype = W.prototype;
    """
    cfg.userContentController.addUserScript(WKUserScript(source: debug, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    cfg.userContentController.add(context.coordinator, name: "log")
    #endif
    cfg.userContentController.add(context.coordinator, name: "joined")
    let v = WKWebView(frame: .zero, configuration: cfg)
    WebPage.noFormBar(v)
    v.navigationDelegate = context.coordinator
    v.uiDelegate = context.coordinator
    v.allowsBackForwardNavigationGestures = false
    v.scrollView.contentInsetAdjustmentBehavior = .never
    v.isOpaque = false
    // The page's own off-white (phone.css --bg) behind it, not the system's white or black: what shows for a moment as
    // the phone turns, or past the top of the page when it's pulled down.
    let paper = UIColor(red: 0xf1 / 255, green: 0xee / 255, blue: 0xe8 / 255, alpha: 1)
    v.backgroundColor = paper
    v.scrollView.backgroundColor = paper
    v.underPageBackgroundColor = paper
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

  /// No Safari form bar (up, down, Done) above the keyboard: an app's own text box has none. WebKit gives the content
  /// view its accessory, so the content view gets a subclass that has none.
  static func noFormBar(_ v: WKWebView) {
    guard let content = v.scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }) else { return }
    let base: AnyClass = type(of: content), name = "\(NSStringFromClass(base))_NoFormBar"
    var cls: AnyClass? = NSClassFromString(name)
    if cls == nil, let c = objc_allocateClassPair(base, name, 0) {
      let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
      if let m = class_getInstanceMethod(UIView.self, #selector(getter: UIResponder.inputAccessoryView)) {
        class_addMethod(c, #selector(getter: UIResponder.inputAccessoryView), imp_implementationWithBlock(none), method_getTypeEncoding(m))
      }
      objc_registerClassPair(c); cls = c
    }
    if let cls { object_setClass(content, cls) }
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
      // Only the app's own page, in its main frame (not an app's frame, nor the tablet's joining page).
      if m.name == "joined" {
        guard m.frameInfo.isMainFrame, m.frameInfo.securityOrigin.protocol == PhonePage.scheme, m.frameInfo.securityOrigin.host == "phone",
              let f = m.body as? String else { return }
        Task { await Home.shared.joined(f) }
        return
      }
      print("[page]", m.body)
    }
    var loaded: URL?

    func webView(_ v: WKWebView, decidePolicyFor a: WKNavigationAction) async -> WKNavigationActionPolicy {
      guard let u = a.request.url else { return .cancel }
      if u.scheme == "openhouse" { await MainActor.run { Home.shared.open(u) }; return .cancel }
      // The joining page went on to the cloud's copy, with the pairing after #: keep it (from the app's own cloud only;
      // one that would move this phone to another home only if the person says so).
      // That copy isn't loaded: the app's own copy of the page is (Home.paired moves to it).
      if a.targetFrame?.isMainFrame != false, let p = Pairing.from(url: u) {
        _ = await Home.shared.paired(p)
        return .cancel
      }
      // Within the page (its own address, the tablet's joining page, its frames) stays here; a link out opens in Safari.
      let same = { (o: URL?) in o.map { $0.scheme == u.scheme && $0.host == u.host && $0.port == u.port } ?? false }
      if a.targetFrame?.isMainFrame == false || PhonePage.isPage(u) || same(v.url) || same(loaded) || u.scheme == "about" || u.scheme == "blob" || u.scheme == "data" { return .allow }
      if ["http", "https", "tel", "mailto", "maps", "shortcuts"].contains(u.scheme ?? "") { await UIApplication.shared.open(u) }
      return .cancel
    }

    // target=_blank: open outside.
    func webView(_ v: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures w: WKWindowFeatures) -> WKWebView? {
      if let u = a.request.url { UIApplication.shared.open(u) }
      return nil
    }

    // Talking to Opie: the microphone, for the household's own page only (the system asks the person first).
    func webView(_ v: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy f: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
      f.isMainFrame && type == .microphone && origin.protocol == PhonePage.scheme && origin.host == "phone" ? .grant : .deny
    }

    func webViewWebContentProcessDidTerminate(_ v: WKWebView) { v.reload() }
  }
}
