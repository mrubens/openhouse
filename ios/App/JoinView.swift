// Joining a home: scan the code the tablet shows (Settings, Screens, Add a screen, Someone's phone), or paste the link
// it carries. That opens the tablet's own joining page here, which joins and hands over to the cloud's copy.
import AVFoundation
import SwiftUI
import VisionKit

struct JoinView: View {
  @State private var scanning = false
  @State private var link = ""
  @State private var wrong = false

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("OpenHouse").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
      Text("Join your home").font(.largeTitle.weight(.semibold))
      Text("On the tablet: Settings, Screens, Add a screen, Someone's phone. Then scan the code it shows.")
        .foregroundStyle(.secondary)
      if DataScannerViewController.isSupported {
        Button { scanning = true } label: { Text("Scan the code").frame(maxWidth: .infinity) }
          .buttonStyle(.borderedProminent).controlSize(.large)
      }
      VStack(alignment: .leading, spacing: 8) {
        Text("Or paste its link").font(.footnote).foregroundStyle(.secondary)
        HStack {
          TextField("http://…", text: $link).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            .textFieldStyle(.roundedBorder).onSubmit(go)
          Button("Join", action: go).disabled(link.isEmpty)
        }
        if wrong { Text("That isn't a link from the tablet's code.").font(.footnote).foregroundStyle(.red) }
      }
      Spacer()
    }
    .padding(24)
    .sheet(isPresented: $scanning) {
      Scanner { s in scanning = false; link = s; go() }.ignoresSafeArea()
    }
  }

  private func go() {
    let s = link.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let u = URL(string: s), ["http", "https"].contains(u.scheme ?? ""), u.fragment?.isEmpty == false else { wrong = true; return }
    wrong = false
    Home.shared.join(u)
  }
}

/// The camera, reading the first QR code it sees.
struct Scanner: UIViewControllerRepresentable {
  var found: (String) -> Void
  func makeCoordinator() -> C { C(found) }
  func makeUIViewController(context: Context) -> DataScannerViewController {
    let v = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
    v.delegate = context.coordinator
    try? v.startScanning()
    return v
  }
  func updateUIViewController(_ v: DataScannerViewController, context: Context) {}
  final class C: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void; var done = false
    init(_ f: @escaping (String) -> Void) { found = f }
    func dataScanner(_ s: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
      for case .barcode(let b) in items { if let v = b.payloadStringValue, !done { done = true; s.stopScanning(); found(v) } }
    }
  }
}
