# Cheaper tablets to test (November 2026)

Opie used to need a strong tablet for on-device speech recognition (Parakeet 0.6B) and a coding agent. Both are gone or going. What the tablet runs now is light: the Node bridge in a 100 MB proot runtime, the home screen in a WebView, the small "Opie" wake-word model, and audio streamed to OpenAI's live voice through our cloud. A cheaper tablet could do this. The only question that no spec sheet answers is the microphones.

The current tablet is a **Samsung Galaxy Tab S10 FE (SM-X520)**, bought for $362.99 on sale (list $499.99). Its microphone peaked at 0.026 of full scale, so the listener's auto-gain runs at its 8× cap (docs/tablet-setup-report.md in the session notes). That's the baseline to beat or match.

## What matters, in order

1. **Microphones.** Far-field pickup across a kitchen, over a TV or a call. No maker in this price range publishes mic count, placement or a far-field claim for tablets, and reviews don't test it. This can only be settled by measurement.
2. **Speaker.** Loud and clear in a kitchen.
3. **Android.** Device-owner QR provisioning and lock-task kiosk. Android 15 or 16 with years of security updates.
4. **Screen.** About 10–12 inches, bright enough, fine on all day.
5. **Performance.** 6–8 GB of RAM and a mid-range chip for the WebView and the background Node process.
6. **Charging.** A charge limit for a tablet that is always plugged in.

## The candidates

Prices are US prices from November 2026 where I could find them, so check the live listing before ordering. List prices have climbed during 2026. For example, the A11+ 8/256 launched at $249.99 and now lists at $379.99, so the sale price is the meaningful number.

| | Price (sale / list) | Out | Chip, RAM | Screen | Speakers | Mics | Android, updates | Charge limit | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **Samsung Galaxy Tab S10 FE** (now) | $363 paid / $500 | 2025 | Exynos 1580, 8 GB | 10.9" 90 Hz, ~600 nits | 2 | not published; low level (8× gain) | 16, 7 years | Yes (Battery Protection) | Baseline |
| **Samsung Galaxy Tab A11+** (ordered: 6 GB / 128 GB) | $213 / $313 at Costco (8 GB: $279 / $380) | late 2025 | Dimensity 7300, 6 or 8 GB LPDDR4X, eMMC | 11" 90 Hz, ~480 nits | 4, Dolby Atmos | not published | 16, 7 OS upgrades and 7 years of security updates | Yes (same One UI) | **Test** |
| **Lenovo Tab Plus Gen 2** | ~$257–290 / $400 | 2026 | Dimensity 7400, 8 GB | 12.1" 2.5K 120 Hz, 680 nits measured | 9 JBL speakers with a woofer; 95% audio score at Notebookcheck | not published | 16, 4 years of security updates | Not confirmed | **Test** |
| **OnePlus Pad Go 2** | $349 / $400 | late 2025 | Dimensity 7300 Ultra, 8 GB, UFS 3.1 | 12.1" 2.8K 120 Hz, ~590 nits (842 in auto) | 4 | one on a short side (GSMArena) | 16, 5 years | Yes, plus bypass charging (OxygenOS 16.0.3) | Fallback: best charging, but barely cheaper |
| **Lenovo Idea Tab Plus (2026)** | ~$260 / $300 | 2025 | Dimensity 6400, 8 GB | 12.1" 2.5K 90 Hz | 4 | not published | 15, 2 OS upgrades and 4 years of security updates | Not confirmed | Skip: slow chip, short updates |
| **TCL NxtPaper 11 Plus** | $220 / $270 | 2025 | Helio-class, 8 GB | 11" matte, dim | 4 (harsh above 70%) | 2 (spec sheet) | 15, short | Not confirmed | Skip: weak chip, speaker and updates |
| **Xiaomi Redmi Pad 2 Pro** | ~$250–305, import | 2025 | Snapdragon 7s Gen 4, 6–8 GB | 12.1" 2.5K 120 Hz | 4, Dolby Atmos | 2 on a long side | HyperOS 2 | — | Skip: HyperOS breaks device-owner QR setup and lock task, and it isn't sold in the US |
| **Motorola Moto Pad 60 Pro** | ~$320–370, import | 2025 | Dimensity 8300, 8–12 GB | 12.7" 3K 144 Hz (dim) | 4, JBL | 2 | updates end at Android 16 | — | Skip: import only, updates already ending |
| **Google Pixel Tablet** | — | 2023 | Tensor G2, 8 GB | 11" | 4 | 4 | updates until June 2028 | Yes | Gone: Google stopped selling it in September 2026 |

Notes:
- Samsung's Battery Protection ("Basic", which stops at 80%) is the setting the S10 FE uses. The A11+ runs the same One UI 8, so it has it too, along with the same device-owner and lock-task behaviour we've already debugged on the S10 FE.
- Lenovo's ZUI and OnePlus's OxygenOS both allow device-owner QR setup in general (both are used in enterprise kiosks), but neither has been tried with our shell. Xiaomi has reports of the device-owner grant being refused during setup and of Home and Recents leaving kiosk mode. That's disqualifying.
- On every candidate, microphone details come down to a teardown photo at best.

## Recommendation: order two

**Ordered (2026-11-20):** the Galaxy Tab A11+, Wi-Fi, 6 GB / 128 GB, from Costco for $212.99 ($100 off $312.99). The listing photos show a folding cover stand, but I haven't confirmed one is included. Results go in a section at the end of this doc once it arrives.

1. **Samsung Galaxy Tab A11+, Wi-Fi (SM-X230), $213 for 6 GB / 128 GB at Costco, or about $279 for 8 GB / 256 GB.** This is the low-risk one: the same maker, One UI, Battery Protection and kiosk path as the S10 FE, with longer updates than anything else here. It costs $150–290 less than the S10 FE. The risks are a dimmer screen (~480 nits), slower eMMC storage, and microphones that may be no better than the S10 FE's. 6 GB is enough now: on the S10 FE, 3.8 GB was still free while it ran the on-device speech models and the coding agent (about 1 GB between them), and those are gone. What's left is the bridge (about 54 MB), the WebView and the wake word. Day 3 of the days-awake test should confirm the free memory.
2. **Lenovo Tab Plus Gen 2, Wi-Fi, 8 GB / 128 GB, about $257–290 on sale.** This is the other bet. It has by far the best speaker in the group (a big plus for voice answers across a kitchen), a brighter screen, a slightly faster chip, and a built-in kickstand, which suits a countertop. The risks are that it's large (12.1", 775 g), it gets only 4 years of security updates, ZUI's kiosk behaviour and charge limit are unverified, and its microphones are unknown. A loud speaker also makes echo cancellation harder, so the echo test matters more here.

If the Lenovo fails the kiosk or charge-limit check, try the **OnePlus Pad Go 2** next. It has a confirmed charge limit and bypass charging and 5 years of updates, but at $349 it saves little against the S10 FE.

## What to test on each, against the S10 FE side by side

Use the same room and the same spot on the counter, and run each test on both tablets.

1. **Setup:** Factory reset, scan the QR code from updates.openhouse.computer/setup, then confirm device owner and lock task LOCKED. Check that Home, Recents and the notification shade can't leave the kiosk, and that the tablet reopens after an update and after a reboot. Note any first-boot account prompts the QR flow can't skip.
2. **Microphone level:** Note the learned auto-gain and the raw peak at normal speaking distance. The S10 FE sits at 8× and 0.026; a tablet that needs less gain is better.
3. **Wake word at 1, 3 and 5 m, and over the TV:** `scripts/wake/bench.mjs` runs the wake test set on the Mac against a simulated microphone. For a real room:
   - run `scripts/voice-rec.sh on 30`;
   - play the test set's spoken clips (`scripts/wake/testset.py`) from a speaker at 1 m, 3 m and 5 m, then again at 3 m with a TV or a call playing at normal volume;
   - pull the recording with `voice-rec.sh pull`, write the truth file by hand (when its name was said) and score it with `scripts/voice-replay.mjs`;
   - Record wake hits, false wakes (an hour of TV with no wake word) and misses.
4. **Live-voice latency:** Measure from the end of speech to the first spoken audio, 20 requests on the same Wi-Fi network. It should match the S10 FE, since the work happens in the cloud. If it doesn't, the cause is the chip or the Wi-Fi radio.
5. **Echo:** With echo cancelling on, ask a question with a long answer and talk over it ("Opie, stop") at 1 m and 3 m. Run `scripts/voice-echo-check.mjs` on the recording: the first table shows what the device's speaker and room allow, and the second shows what `bridge/echo.js` made of it. Do this at the volume the family would really use, and at maximum volume.
6. **Speaker:** Check whether answers are understandable at 5 m with the range hood or water running, and whether the sound distorts at maximum volume.
7. **Days awake:** Plug in, turn on the charge limit and leave it running 72 hours or more. Check that the screen and the bridge stay up and that the phantom-process settings hold. Track battery temperature and the charge level (it should stay at the limit, not 100%), memory available, and whether the wake word still works on day 3. Note any vendor battery saver that kills the bridge.
8. **Brightness:** Check that the screen is readable at a slant in a sunny kitchen, and look at the dimmest level that works at night.

## What it means for "a tablet from us" ($399)

**Replaced on 2026-11-26.** Opie doesn't sell tablets for now. A household buys one from [the list](tablets.md) and
sets it up itself with [the guide](setup.md); a few get one set up by hand. The website no longer shows a tablet or a
price. What follows is the $399 plan as it stood, kept for the record.

The landing page sells a set-up tablet at $399 with the first year of the cloud included.

- **On the S10 FE**, the tablet alone is $363 on sale and $500 at list. At list price we lose money before shipping, setup time or the cloud year. At $399 the S10 FE only works when it's on sale.
- **On the A11+ at Costco's $213**, there's about $186 left from $399, but that's a sale price (limited to 5 per member) and the regular price is $313.
- **On the A11+ 8 GB (about $279) or the Tab Plus Gen 2 (about $257–290)**, there's about $110–140 left from $399 for shipping, a stand or mount, setup, and a year of cloud (voice, backups and the hourly review; docs/heartbeat.md estimates the review alone at well under a cent a day). The $399 price holds without relying on a sale, and a cheaper option at $299–349 becomes possible if either tablet passes.
- **Both prices are sale prices.** The list prices ($380 and $400) would put us back near break-even, so a sourcing plan needs volume or a reseller price, not Amazon deals.
- If neither tablet's microphones match the S10 FE, keep the S10 FE and treat a small USB or Bluetooth microphone as the thing to test next, rather than going down in tablet quality.

An A11+ (6 GB) was ordered to test on 2026-11-20. Nothing else has been ordered.

## Sources

- Galaxy Tab A11+: [Notebookcheck, 7 years of updates](https://www.notebookcheck.net/Samsung-launches-Galaxy-Tab-A11-Plus-with-DeX-and-7-years-of-updates.1128130.0.html), [GSMArena specs](https://www.gsmarena.com/samsung_galaxy_tab_a11+-14192.php), [Android Authority $279 deal, Nov 2026](https://www.androidauthority.com/samsung-galaxy-tab-a11-plus-256gb-deal-3735661/), [Neowin launch price](https://www.neowin.net/news/samsung-launches-new-11-inch-galaxy-tab-a11-on-a-budget-ahead-of-new-years-eve/), [My Next Tablet, 480 nits](https://mynexttablet.com/samsung-galaxy-tab-a11-review-2/)
- Lenovo Tab Plus Gen 2: [Notebookcheck review](https://www.notebookcheck.net/The-tablet-with-the-best-sound-system-in-years-Lenovo-Tab-Plus-Gen-2-in-review.1402404.0.html), [Notebookcheck lowest price](https://www.notebookcheck.net/Lenovo-Tab-Plus-Gen-2-Entertainment-tablet-with-95-audio-rating-drops-to-lowest-price.1409433.0.html), [Notebookcheck North America launch](https://www.notebookcheck.net/Lenovo-s-Tab-Plus-Gen-2-tablet-launches-in-North-America-with-2-5K-120Hz-display-and-JBL-speakers.1344193.0.html), [Tom's Guide review](https://www.tomsguide.com/computing/tablets/lenovo-tab-plus-gen-2-review), [Lenovo datasheet](https://psrefstuff.lenovo.com/syspool/Sys/PDF/datasheet/Lenovo%20Tab%20Plus%20Gen%202_Datasheet_EN.pdf)
- OnePlus Pad Go 2: [GSMArena review](https://www.gsmarena.com/oneplus_pad_go_2-review-2931.php), [Android Authority launch](https://www.androidauthority.com/oneplus-pad-go-2-launch-3625303/), [HotHardware $349](https://hothardware.com/reviews/oneplus-pad-go-2-review-scaled-back-with-compromises), [Notebookcheck bypass charging](https://www.notebookcheck.net/System-wide-bypass-charging-rolls-out-to-more-OnePlus-phones-with-the-latest-OxygenOS-update.1214115.0.html)
- Lenovo Idea Tab Plus: [Android Authority review](https://androidauthority.com/lenovo-idea-tab-plus-review-3674214), [GSMArena launch](https://gsmarena.com/lenovo_unveils_the_competitively_priced_yoga_tab_and_idea_tab_plus_tablets-news-69384.php)
- TCL NxtPaper 11 Plus: [Android Authority review](https://androidauthority.com/tcl-nxtpaper-11-plus-review-3681246), [Senses.se review](https://www.senses.se/en/review-tcl-nxtpaper-11-plus/), [TCL US](https://us.tcl.com/products/nxtpaper-11-plus-tablet)
- Redmi Pad 2 Pro and HyperOS kiosk mode: [GSMArena review](https://m.gsmarena.com/xiaomi_redmi_pad_2_pro-review-2891.php), [Android Enterprise community bug report](https://www.androidenterprise.community/android-enterprise-general-discussions-3/bug-report-xiaomi-redmi-12c-android-enterprise-fully-managed-enrollment-fails-via-zero-touch-and-qr-code-with-microsoft-intune-2563), [ManageEngine kiosk bug](https://pitstop.manageengine.com/portal/en/community/topic/bug-in-kiosk-mode)
- Moto Pad 60 Pro: [Notebookcheck verdict](https://www.notebookcheck.net/Verdict-on-the-Moto-Pad-60-Pro-Fantastic-designer-tablet-with-one-major-drawback.1112933.0.html)
- Pixel Tablet: [9to5Google, discontinued](https://9to5google.com/2026/09/09/google-pixel-tablet-discontinued/)
- Galaxy Tab S10 FE: [Best Buy](https://www.bestbuy.com/site/6618945.p)
