// The app's keys and boxes must be the tablet's own (bridge/screens.js, chat/src/seal.js), or nothing it sends opens and
// a wrong derivation could hand the share extension more than its one route. Values made with the bridge's code.
import XCTest

final class SealTests: XCTestCase {
  let key = B64.dec("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!

  func testDerivedKeysMatchTheTablet() {
    XCTAssertEqual(Seal.relayToken(key), "TUcrGkRAUoFd5MLfUG78nA")
    XCTAssertEqual(B64.enc(Seal.shareKey(key)), "0GW4r6Lm-JIkRzu3ttP2_fgqOZWW6rvYZV7iCicTCAE")
    XCTAssertEqual(B64.enc(Seal.noteKey(key)), "1KOAMRaxI4LwX3zitGfdpMIIs2wosJvFSBLiu8rhdZU")
  }

  func testOpensThePagesBoxAndOnlyWithItsLabel() {
    let box = B64.dec("BwcHBwcHBwcHBwcH3XbzjQkDIljRFq3FTzEviPAULiFTURw")!
    XCTAssertEqual(Seal.open(key, aad: "req:ph1", box).map { String(decoding: $0, as: UTF8.self) }, #"{"n":1}"#)
    XCTAssertNil(Seal.open(key, aad: "req:ph2", box))
    XCTAssertNil(Seal.open(Seal.shareKey(key), aad: "req:ph1", box))
    let mine = Seal.seal(key, aad: "note:ph1", Data("hi".utf8))
    XCTAssertEqual(Seal.open(key, aad: "note:ph1", mine), Data("hi".utf8))
  }

  func testPairingOnlyFromAWholeCloudLink() {
    let good = URL(string: "https://cloud.example.com/h/#ph1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8.r1.t1.e30")!
    XCTAssertEqual(Pairing.from(url: good)?.page, "https://cloud.example.com/h/")
    XCTAssertNil(Pairing.from(url: URL(string: "http://cloud.example.com/h/#ph1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8.r1.t1.e30")!)) // not https
    XCTAssertNil(Pairing.from(url: URL(string: "https://cloud.example.com/h/#ph1.short.r1.t1.e30")!))
    XCTAssertNil(Pairing.from(url: URL(string: "http://192.168.1.5:8788/phone/#pair1.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")!))
  }
}
