// Notes and reminders for this phone's person, by APNs: the app gives the tablet its device token (POST /phone/push
// {apns}), and the tablet sends each note sealed with this phone's note key through the cloud (bridge/screens.js
// notify). The notification extension (Notes/) opens it here. Tapping one opens what it's about.
import UIKit
import UserNotifications

final class Delegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    if PairingStore.load() != nil { app.registerForRemoteNotifications() } // (a token can change: told again each launch)
    return true
  }

  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
    let hex = token.map { String(format: "%02x", $0) }.joined()
    Task { await Notes.tell(hex) }
  }

  func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    print("[notes] no device token:", error.localizedDescription)
  }

  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }

  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse) async {
    if let open = r.notification.request.content.userInfo["open"] as? String { await MainActor.run { Home.shared.openNote(open) } }
  }
}

enum Notes {
  #if DEBUG
  static let env = "sandbox"
  #else
  static let env = "production"
  #endif

  /// Asked once, right after joining, for a phone the household lets get notes.
  static func turnOn(_ p: Pairing) async {
    guard p.canNotify else { return }
    let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    if ok { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
  }

  static func tell(_ token: String) async {
    guard let p = PairingStore.load(), p.canNotify else { return }
    let key = "openhouse.apns.\(p.id)"
    if UserDefaults.standard.string(forKey: key) == token { return }
    let t = Tablet(p); defer { t.close() }
    if let r = try? await t.request("POST", "/phone/push", ["apns": ["token": token, "env": env]]), r.json?["on"] as? Bool == true {
      UserDefaults.standard.set(token, forKey: key)
    }
  }
}
