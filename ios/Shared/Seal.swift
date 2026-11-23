// The same sealing as the phone page and the tablet (chat/src/seal.js, bridge/screens.js): ChaCha20-Poly1305 boxes
// laid out nonce | ciphertext | tag, with a label as the associated data, and keys derived from the phone's own key
// with HKDF-SHA256 (no salt), so nothing new has to be kept or handed out.
import CryptoKit
import Foundation

enum B64 {
  /// base64url without padding, as the page and the tablet write it.
  static func enc(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  static func dec(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }
}

enum Seal {
  static func seal(_ key: Data, aad: String, _ plain: Data) -> Data {
    // (Only fails for a key that isn't 32 bytes, which a pairing never has.)
    (try? ChaChaPoly.seal(plain, using: SymmetricKey(data: key), authenticating: Data(aad.utf8)).combined) ?? Data()
  }

  static func open(_ key: Data, aad: String, _ box: Data) -> Data? {
    guard key.count == 32, box.count >= 28, let sealed = try? ChaChaPoly.SealedBox(combined: box) else { return nil }
    return try? ChaChaPoly.open(sealed, using: SymmetricKey(data: key), authenticating: Data(aad.utf8))
  }

  /// HKDF-SHA256 of the phone's key with an empty salt, as Node's hkdfSync('sha256', key, '', label, n).
  static func derive(_ key: Data, _ label: String, _ n: Int) -> Data {
    let k = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: key), salt: Data(), info: Data(label.utf8), outputByteCount: n)
    return k.withUnsafeBytes { Data($0) }
  }

  /// The relay token the tablet expects from this phone (bridge/screens.js relayToken).
  static func relayToken(_ key: Data) -> String { B64.enc(derive(key, "openhouse relay", 16)) }
  /// The share key: opens only POST /phone/share on the tablet (screens.js shareKey), for the share extension.
  static func shareKey(_ key: Data) -> Data { derive(key, "openhouse share", 32) }
  /// The key notes come sealed with through APNs (screens.js noteKey): the cloud and Apple pass them on unopened.
  static func noteKey(_ key: Data) -> Data { derive(key, "openhouse note", 32) }
}
