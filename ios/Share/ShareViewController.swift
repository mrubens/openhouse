// Send to Opie from any app's share sheet: a link, words or a photo go to the cloud's /send, sealed for home there
// with this phone's share key (the same way as the old Shortcut: openhouse-cloud lambda/send.ts), and Opie's answer
// shows here. The share key opens only POST /phone/share on the tablet, and comes from the phone's own key.
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private let model = SendModel()

  override func viewDidLoad() {
    super.viewDidLoad()
    let host = UIHostingController(rootView: SendView(model: model, close: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
    Task { await model.send(items: extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
  }
}

@MainActor final class SendModel: ObservableObject {
  @Published var words = "Sending to Opie…"
  @Published var done = false

  func send(items: [NSExtensionItem]) async {
    guard let p = PairingStore.load() else { return finish("Open OpenHouse and join your home first.") }
    guard p.canAsk else { return finish("This phone can't ask Opie. That's chosen on the tablet, in Settings, Screens.") }
    guard let (body, type) = await Self.item(items) else { return finish("Nothing came through to send.") }
    guard let url = URL(string: p.origin + "/send") else { return finish("This phone isn't linked to the cloud.") }
    var r = URLRequest(url: url, timeoutInterval: 40)
    r.httpMethod = "POST"
    r.setValue("OpenHouse \(p.relay).\(p.id).\(p.token).\(B64.enc(Seal.shareKey(p.keyData)))", forHTTPHeaderField: "authorization")
    r.setValue(type, forHTTPHeaderField: "content-type")
    r.httpBody = body
    do {
      let (d, _) = try await URLSession.shared.data(for: r)
      finish(String(decoding: d, as: UTF8.self))
    } catch { finish("Home didn't answer. Try again in a moment.") }
  }

  private func finish(_ s: String) { words = s.isEmpty ? "Sent." : s; done = true }

  /// The first thing shared: a photo (made a JPEG no wider than 1600), else a link, else words.
  static func item(_ items: [NSExtensionItem]) async -> (Data, String)? {
    let providers = items.flatMap { $0.attachments ?? [] }
    for pr in providers where pr.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
      if let img = await image(pr), let jpg = shrink(img).jpegData(compressionQuality: 0.8) { return (jpg, "image/jpeg") }
    }
    var words: [String] = []
    for pr in providers {
      if pr.hasItemConformingToTypeIdentifier(UTType.url.identifier), let u = try? await pr.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { words.append(u.absoluteString) }
      else if pr.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), let t = try? await pr.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String { words.append(t) }
    }
    let text = words.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : (Data(text.prefix(4000).utf8), "text/plain; charset=utf-8")
  }

  private static func image(_ pr: NSItemProvider) async -> UIImage? {
    guard let x = try? await pr.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
    if let i = x as? UIImage { return i }
    if let u = x as? URL, let d = try? Data(contentsOf: u) { return UIImage(data: d) }
    if let d = x as? Data { return UIImage(data: d) }
    return nil
  }

  private static func shrink(_ i: UIImage) -> UIImage {
    let w = i.size.width * i.scale
    guard w > 1600 else { return i }
    let size = CGSize(width: 1600, height: (i.size.height * i.scale) * 1600 / w)
    let f = UIGraphicsImageRendererFormat(); f.scale = 1
    return UIGraphicsImageRenderer(size: size, format: f).image { _ in i.draw(in: CGRect(origin: .zero, size: size)) }
  }
}

struct SendView: View {
  @ObservedObject var model: SendModel
  var close: () -> Void
  var body: some View {
    VStack(spacing: 18) {
      Text("Opie").font(.headline)
      if !model.done { ProgressView() }
      ScrollView { Text(model.words).font(.body).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 280)
      Button(model.done ? "Done" : "Close", action: close).buttonStyle(.borderedProminent)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Color(.systemBackground))
  }
}
