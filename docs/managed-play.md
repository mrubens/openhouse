# Managed Google Play: apps with no Google account on the device

An investigation (2026-11-27), not a plan of record. The question: can an Opie device get Android apps from Google Play
silently, with nobody's Google account signed in on it, using Android Enterprise? Today (`PlayStore.kt`,
`docs/device-control.md`) adding YouTube TV or Netflix means signing a Google account into the device, and that
account is then signed in to every Google app there.

Short answer: yes, technically, but only by handing the device to Google's own device policy app (Android Device
Policy) through the Android Management API. Opie stops being the device owner. Google has to approve Opie as a
commercial EMM first, and whether a household product fits Google's terms is unclear. It isn't worth a rebuild now. A
smaller step is below.

"Verified" below means a Google page says so. "Not verified" means I found nothing either way and it needs a test
device or a question to Google.

## 1. The ways in, and which are open

| Route | Who runs the device | Open to a new small company? |
|---|---|---|
| Android Management API (AMAPI) | Google's Android Device Policy | Yes, after approval |
| Play EMM API with Opie as a custom DPC | Opie's shell | No: closed to new registrations |
| An existing EMM's API (Esper, Scalefusion, Hexnode…) | Their agent or Android Device Policy | Yes, paid per device |
| Google Workspace / Cloud Identity as the enterprise | Whichever of the above | Not a separate route: it's just the kind of enterprise |

- **Play EMM API (custom DPC)**: "no longer accepting new registrations for custom device policy controllers".
  Existing partners keep it. New EMMs are told to use AMAPI. ([register](https://developers.google.com/android/work/play/emm-api/register),
  [Play EMM API](https://developers.google.com/android/work/play/emm-api))
- **AMAPI** only works with Google's DPC: Android Device Policy "is the only device policy controller compatible"
  with it. ([introduction](https://developers.google.com/android/management/introduction))
- **Who may use AMAPI**: only commercial EMM developers, who sell "to entities outside of their immediate company"
  and "have a direct agreement with its end customers". Not allowed: solutions only for in-house apps, monitoring,
  device financing, and auto-installing apps without informed consent. Households, consumers and parental controls
  aren't mentioned either way. ([permissible usage](https://developers.google.com/android/management/permissible-usage))
- **Approval and quota**: since 1 Nov 2025, AMAPI "device enrollment requires Android Enterprise registration and
  approval" (a request form). The first quota is up to 500 devices and needs "a full business justification"; more
  means applying again. Quota is for at most 2 projects per developer. ([release notes](https://developers.google.com/android/management/release-notes),
  [permissible usage](https://developers.google.com/android/management/permissible-usage)) No price is published;
  as far as I know the API itself costs nothing (not verified).
- **The enterprise**: each customer (here, each household) signs up through `signupUrls.create`. A plain Gmail
  address can sign up, if it isn't already tied to another enterprise. That account is used on the web, not on the
  device. Since 2025 enterprises have a type: managed Google Play Accounts, or a managed Google domain that they can
  upgrade to. ([create enterprise](https://developers.google.com/android/management/create-enterprise),
  [quickstart](https://developers.google.com/android/management/quickstart), release notes March 2025)
- **The managed Google Play agreement** says it's for "Your organization", and apps pushed to people should be
  "necessary and required as part of the End User's employment". It doesn't forbid household use in so many words,
  but it's written for employers. ([terms](https://www.android.com/enterprise/terms/))

**Is a household product allowed?** Unclear. Opie would sell to people outside the company and have an agreement with
each household, which fits the EMM definition. But Google's agreement is written around employers and employees, and
Google decides at approval. This is the first thing to ask Google (the request form above), before any code.

**DIY**: a DIY household can't run its own AMAPI project for itself (that is "in-house" use, and needs approval). It
would ride on Opie's approved project or skip managed Play. This works against "a self-run version of every cloud
piece".

## 2. Opie under Android Device Policy: what changes per feature

Opie's shell becomes an ordinary app that the policy installs, puts in kiosk mode and grants permissions to. Fields
are from the [Policy reference](https://developers.google.com/android/management/reference/rest/v1/enterprises.policies)
and the [dedicated devices guide](https://developers.google.com/android/management/policies/dedicated-devices).

| Feature today | Under AMAPI | Policy field(s) |
|---|---|---|
| Opie is home and in lock task | Kept. The kiosk app starts at boot, full screen | `applications[].installType: KIOSK` or `kioskCustomLauncherEnabled`; `kioskCustomization` (`statusBar`, `systemNavigation`, `powerButtonActions`, `deviceSettings`, `systemErrorWarnings`) |
| Other apps allowed in kiosk (family apps, added apps) | Kept, by listing them in the policy | `applications[]` with a non-KIOSK `installType` |
| Settings or Play let in for one moment, then shut | Changes: a policy change from the cloud each time, not a local call | `kioskCustomization.deviceSettings`, the app list |
| PIN-gated "leave kiosk mode" | Changes: Opie can't leave lock task by itself. Only a policy change exits kiosk; I found no kiosk-exit PIN. Opie checks the PIN, then its cloud patches the policy. Offline, or with the cloud down, nobody can get out | `installType` away from `KIOSK` |
| Device control (accessibility) switched on by Opie | Lost as automatic: the policy can only allow a service, not turn it on. A person turns it on once in Android's settings | `permittedAccessibilityServices` (allowlist only) |
| `WRITE_SECURE_SETTINGS` (phantom-process limit off, device control on) | Lost: no adb grant on a managed device in normal use, and no policy for it. Not verified whether Samsung still kills Opie's child processes without it | none |
| Self-update (Opie installs its own APK) | Changes: either Opie is published on Play (as a private or public app) and Play updates it, or it's a "custom app" installed by an extension app through the AMAPI SDK. Whether the SDK install is silent, and whether an app can update itself that way, isn't stated (not verified). The rescue/rollback flow in `docs/self-update.md` would need rethinking | `installType: CUSTOM` + `customAppConfig` + `signingKeyCerts`; extension app with role `COMPANION_APP`; SDK `LocalCommandClient` `InstallCustomApp` ([custom apps](https://developers.google.com/android/management/manage-custom-apps)) |
| Runtime (Linux binaries, models) downloaded by Opie | Kept: not an install. But if Opie itself went on Play, Play's policy on running downloaded code would apply (not checked) | none |
| Silent installs of apps the household adds | Gained: the point of the change | `applications[]` `{packageName, installType: FORCE_INSTALLED}` |
| Microphone always on (wake word) | Kept | `permissionGrants` `RECORD_AUDIO: GRANT` or `defaultPermissionPolicy: GRANT` |
| Awake while plugged in | Kept | `stayOnPluggedModes` |
| Android's updates only at night | Kept | `systemUpdate {type: WINDOWED, startMinutes, endMinutes}` |
| No factory reset, safe boot, new users, unknown sources | Kept | `factoryResetDisabled`, `advancedSecurityOverrides.developerSettings`, `addUserDisabled`, `advancedSecurityOverrides.untrustedAppsPolicy` |
| USB debugging switch | Changes: a policy change from the cloud | `advancedSecurityOverrides.developerSettings` |
| No lock screen | Kept (dedicated devices only) | `keyguardDisabled` |
| Factory reset protection off | Kept: an empty list means none | `frpAdminEmails` |
| Erase | Kept, from the cloud (`devices.delete`) or locally through the SDK's wipe command | role `COMPANION_APP` + `extraCapabilities.localDeviceWipeCommand` (SDK 1.9+) ([local commands](https://developers.google.com/android/management/sdk-local-commands)) |
| Wallpaper, persistent home, hiding launchers | Mostly kept by the kiosk fields; the wallpaper and other `DevicePolicyManager` calls Opie makes itself are lost | `kioskCustomLauncherEnabled`, `persistentPreferredActivities` |
| Works with no Opie cloud | Lost: the cloud holds the enterprise and writes every policy change | none |

Also: moving an existing tablet means a factory reset (a device owner can't be swapped), and Google's Android Device
Policy becomes a second party on every household's device.

## 3. Per-device setup and adding an app

- **Enrolling**: the cloud calls `enterprises.enrollmentTokens.create` (with a policy name, and
  `PERSONAL_USAGE_DISALLOWED_USERLESS` for a device with no user), which returns a ready QR code. Someone taps the
  welcome screen six times and scans it, as with today's `scripts/provision-qr.sh`, but the code installs Android
  Device Policy, not Opie. Tokens last an hour by default; the length can be set. Zero-touch works through a
  reseller. ([provision a device](https://developers.google.com/android/management/provision-device))
- **No Google account on the device**: a userless dedicated device gets an anonymous account, not a person's.
  (provision a device; how Play signs in underneath isn't described)
- **Adding an app on demand**: Opie (behind the PIN, as now) asks its cloud, which patches the device's policy:
  `applications[] += {packageName, installType: FORCE_INSTALLED}`. No approval step is described; the managed Play
  iframe is only for finding package names, and Opie's own Play search already does that.
  ([apps](https://developers.google.com/android/management/apps)) Paid apps: not covered.
- **How fast**: not documented. My experience is minutes, not seconds (not verified).
- **Still not solved**: YouTube TV is a Google subscription, so as far as I know its app needs the subscriber's Google
  account signed in on the device anyway (not verified). Netflix and others use their own sign-in. Whether every app
  is offered in managed Play wasn't verified either.

## 4. Keeping Opie as device owner

- **Managed Google Play accounts from Opie's own DPC**: that's the Play EMM API, closed to new custom DPCs. Nothing
  else lets a custom DPC have managed Play.
- **AMAPI with Opie as DPC**: not possible; Android Device Policy is the only DPC.
- **`ManagedConfigurations`** only sets settings of apps that are already installed; it doesn't install anything.
- **An existing EMM's API** (they still hold Play EMM access or use AMAPI): about $2–6 per device per month with
  10–25 device minimums ([Esper](https://www.esper.io/pricing), [Scalefusion](https://www.scalefusion.com/pricing),
  [Hexnode](https://hexnode.com/mobile-device-management/pricing/)). Their agent or Google's becomes the device owner,
  so it has the same losses as section 2 plus a vendor, and the same open question about households.
- **Watch out**: Google now keeps an allowlist of DPCs "permitted to install apps during enterprise device enrollment
  provisioning"; others get "App blocked to protect your device".
  ([DPC allowlist](https://support.google.com/work/android/answer/16694822)) The page doesn't say whether it covers a
  QR-provisioned DPC that uses no Google enterprise API, like Opie today. Worth checking on a fresh tablet with
  current Play services, whatever is decided here.

## 5. Recommendation

**Don't rebuild now.** It costs Opie its device ownership, the offline escape hatch, automatic device control and the
self-update design, it makes every escape a cloud round trip, it rules out DIY, and it can't start until Google approves
Opie, which may not happen for a household product. It still doesn't remove the Google account for YouTube TV.

**Smaller step, now (days, not weeks):**

1. **An account just for the tablet, and only Play can use it.** Opie already suggests one. As device owner it can also
   hide the Google apps that would sign in with it (Gmail, Chrome, Photos, YouTube unless asked for:
   `setApplicationHidden`), so the account reaches Play and nothing else. Untested: whether Google's sign-in on a
   device-owner tablet takes a personal Gmail (on the emulator it asks for a "work account").
2. **Sign out after adding** (a choice in Connections → Google Play): Opie removes the account once the install is
   done. Apps stay installed; they stop getting Play updates until someone signs in again. Needs a test that apps
   keep working afterward (paid apps with licence checks may not).

**If it's still wanted later (rough size: 4–8 weeks, plus Google's review):**

1. File Google's Android Enterprise request form with Opie's real use, and ask outright whether household devices
   sold by Opie qualify. Nothing else until they say yes.
2. Cloud: an AMAPI project and service account, an enterprise per household (signup URL flow), and a policy service
   that Opie's bridge calls for kiosk, apps, settings and erase.
3. Device: Opie as a KIOSK app plus an AMAPI SDK extension app (self-update as a custom app, local wipe), new
   provisioning QR, a "turn on device control" setup step, and rewriting `DeviceOwner.kt`, `Kiosk.kt`, `KioskApps`,
   `AppStore.kt`, `PlayStore.kt` and the updater around policy calls.
4. A factory reset for each existing tablet.

**What the owner would sign up for**: a Google Cloud project with the Android Management API, Android Enterprise
registration and approval (the form), an agreement with each household as their EMM, and each household (or Opie on
its behalf) creating a managed Google Play enterprise with some Google account on the web.
