# Reaching the tablet from away from home

Status: the relay's first version is built (workshop computers, paired screens, phone list pages), tested end to end
against the local service and on an emulator. Not deployed: `relay.openhouse.computer` waits on a `cdk deploy` and a
CNAME. Decisions and what's left: the end of this page.

## What needs it

| What | Today | Away from home |
| --- | --- | --- |
| The workshop MCP (`bridge/workshop.js`, `connect/`, [workshop-mcp.md](workshop-mcp.md)) | Paired computers reach `:8788` on the Wi-Fi (`opie.local`, Bonjour `_openhouse._tcp`) | Doesn't connect |
| Phone pages for lists (`shell/.../ui/Phone.kt`, `assets/list.html`, [built-in-apps.md](built-in-apps.md)) | Live for 3 hours on the Wi-Fi | The page keeps working offline; ticks reach the tablet only back home |
| Paired screens ([brain-screens.md](brain-screens.md)) | Wi-Fi only | Not needed away (a screen lives in the house) |
| Remote help for beta households | None | Wanted, only with the household's OK |
| claude.ai / ChatGPT connectors, push notifications, a stable https address per household (the cloud repo's docs, "Not in this slice") | Planned | Need something reachable from the internet |

## What we already have that matters here

Everything that crosses the Wi-Fi today is **sealed end to end** with a key only the tablet and that device hold:

- Paired screens and computers: each request to `POST /s` is ChaCha20-Poly1305 under the device's own key, with a
  counter against replays, and the reply streams back as sealed frames (`bridge/screens.js`, `chat/src/screen-client.js`).
  The tablet checks scopes (an allowlist of routes) after opening it.
- Phone pages: the key is in the QR code's `#fragment`, never sent anywhere; `/i` and `/s` are sealed with it (`Handoff.kt`).

So whatever carries the bytes between a phone or computer and the tablet never needs to be trusted with their
contents. That changes the comparison: the carrier only has to get bytes there, and keep strangers from costing us money.

## Who serves the code that holds a device's key

Sealing protects what crosses the network, but the page that does the sealing holds the key, so it is only as safe
as whoever serves that page's code. Where each device's code comes from (2026-11-25):

| Device | Its code comes from | Over |
|---|---|---|
| The iPhone app | the app itself: the phone page built into it (`chat/phone-page.mjs`, served at `openhouse-app://phone/h/` by `ios/App/PhonePage.swift`) | nothing: Apple-signed |
| A phone or screen's browser at home, with the tablet's https name | the tablet | https, `t-<random>.<lan domain>` with the tablet's own Let's Encrypt certificate |
| The same without it (no cloud link, a router that refuses such names, no internet to look the name up) | the tablet | plain http on the Wi-Fi |
| A phone or screen's browser with the household's own Tailscale on (no cloud needed: "Tailscale, for households without Opie cloud") | the tablet | https at `opie.<tailnet>.ts.net`, Tailscale's certificate (WireGuard underneath) |
| A phone's browser away from home (the cloud's `/h/`, and list and photo pages: `/l`, `/p/`) | the cloud | https |
| A computer's MCP | the package installed on the computer | (its own code) |

What's left, known and accepted:
- **Browser phones away from home trust the cloud's code.** The cloud's copy of the phone page is the code that holds
  the phone's key there, so a compromised cloud could serve one that leaks it. The cloud never sees the key otherwise
  (it stays after `#`), and the relay only ever carries sealed bytes. The iPhone app is the path that doesn't trust the
  cloud's code: its page is in the app. (Android phones have no app yet.)
- **Plain http where there's no https name.** Someone on the Wi-Fi could change the page a browser loads over plain
  http. Screens and phones joined before the name existed stay on their http address (their storage is that origin's;
  moving them would mean joining again); new codes and links use the https name.
- The iPhone app's joining step opens the tablet's joining page (`/phone/`) in the app, so it is as safe as that page's
  address: the https name when the tablet has one.

### An https address at home

Each linked tablet gets a name of its own whose DNS answer is its address on the Wi-Fi, and a certificate for it,
so a browser at home gets the tablet's pages over TLS with no warning and no setup.

- **The name**: `t-<10 random letters>.<lanDomain>` (e.g. under `lan.openhouse.computer`). Random, not the tablet's
  id: certificates are public (Certificate Transparency), so the name says nothing about whose it is. Its A record is
  the tablet's private address (only RFC 1918 addresses are accepted, so the domain never names anyone else's server).
- **The cloud** (`openhouse-cloud/lambda/lan.ts`) keeps the records in a Route 53 zone of their own and only for a
  linked tablet, by its Device credential: `POST /v1/lan/name {ip}`, `/v1/lan/challenge {value}`,
  `/v1/lan/challenge/done`, `/v1/lan/forget`. One name per tablet, kept across forget (it never goes to another tablet
  while an old certificate could be valid); at most 3 new names a household a week; 12 address changes and 10
  challenges an hour per tablet. Unlinking, revoking or deleting the account removes the records and releases the name.
- **The tablet** (`bridge/lan-tls.js`, `bridge/acme.js`: ACME with only `node:crypto`) makes its own keys, asks Let's
  Encrypt for the certificate, and proves the name by DNS-01: the cloud puts the challenge's digest in
  `_acme-challenge.<name>`. The cloud never has the key, and couldn't use the certificate without it. Keys and the
  certificate are in `.lan-tls/` next to the cloud link (mode 600, not in backups). It renews when a third of the
  certificate is left (every ~60 days for Let's Encrypt's 90), with a new key each time; failures wait 1, 6, then 24
  hours before trying again. The shell tells the bridge its address (`POST /screens/address`, when the network
  changes); a hub can set `LAN_ADDRESS`. A step that can't reach the cloud (a new address while the internet is down)
  is tried again after 1, 3, 10, then every 30 minutes. The certificate goes only when the tablet is unlinked for
  certain (revoked, or unlinked on the tablet); after another refused credential it stays, and a relink asks for the
  same name back (`keep`). `LAN_TLS=off` turns it off.
- **Connections** on that port must send a request's headers within 20 s, its body within 60 s, and anything at all
  within 3 minutes; turning the home network off closes them all.
- **Serving**: the home network's port (8788) answers both: a connection that starts with a TLS handshake gets https
  with the certificate, any other plain http (`bridge/screens.js`). A hub with its own certificate (`HUB_TLS_CERT`)
  stays https only, as before.
- **Links and QR codes** use `https://<name>:8788` only while the tablet, looking its name up through the router as a
  phone would, gets its own address back (checked every 30 minutes). Otherwise they stay `http://<address>:8788`.
  That covers routers that drop public names pointing at home addresses (DNS rebinding protection), and the internet
  being down. Once it has a certificate the tablet keeps serving it with no internet or cloud; only renewing needs them.
  Computers keep their plain address: their MCP code is their own, and they seal everything.

Before many households (Let's Encrypt's limits, checked 2026-11-25 on letsencrypt.org/docs/rate-limits):
- 50 new certificates per registered domain every 7 days, shared by every account. All tablets' names are under
  one registered domain, so that's ~50 new tablets a week. Renewals of the same name are exempt from it (and fully
  exempt when the client uses ARI, which `acme.js` doesn't yet). The fix is Let's Encrypt's rate-limit adjustment
  form for the domain (https://isrg.formstack.com/forms/rate_limit_adjustment_request); it takes a week or two.
- The Public Suffix List is not the way: it refuses entries whose only purpose is getting around a CA's limits.
- 5 certificates per exact name a week, 5 failed validations per name an hour, 10 new accounts per IP every 3 hours:
  none matter for one tablet, which keeps one account and renews every ~60 days.
- Let's Encrypt's account is made by each tablet, with no email, agreeing to its Subscriber Agreement.

## The three ways

### 1. Tailscale on the tablet

Built since 2026-11-27, as an option for households without Opie cloud: "Tailscale, for households without Opie
cloud" below. What follows was the comparison before.

The tablet runs a userspace Tailscale node (`tailscaled --tun=userspace-networking`, or a small `tsnet` program; both
are Go, shipped as a native binary in the runtime the way Node is). Android's VPN slot is a poor fit: a kiosk would
have to hold the system VPN, one app at a time, with a key icon in the status bar, and it would carry every app's traffic.

- **Setup for a household:** make a Tailscale account (Google, Microsoft, Apple or GitHub sign-in); on the tablet,
  Settings → Away from home → open a sign-in link on a phone, or bring an auth key from the admin console by QR; install
  Tailscale on each phone and computer and keep it switched on. At the shop the phone's Tailscale VPN must be on.
- **Whose tailnet:** the household's own is the only clean one. Putting households' tablets in *our* tailnet means
  every household's devices share one network that we administer (ACLs have to keep households apart, and a mistake
  there exposes everyone); it is business use under Tailscale's terms, priced per user or device; and household phones
  would have to join our tailnet too, or be shared into it node by node.
- **Costs us:** nothing with households' own tailnets. A ~30 MB binary in the runtime, its updates, and support for
  "Tailscale says logged out".
- **Security:** a stolen phone or laptop that is still in the tailnet reaches the tablet's ports from anywhere until
  removed in Tailscale's console (and our pairing still has to be revoked on the tablet, since the sealing keys are ours).
  A leaked auth key joins a stranger's node to the household's tailnet. Two places to revoke.
- **Privacy:** Tailscale's coordination server sees device names, OS, addresses and when they are online; DERP relays
  carry WireGuard-encrypted packets. A service the household chose, so it fits the rule, but it is one more account.
- **Who it works for:** best for open-source self-installers who already run Tailscale. Too much setup for a household
  that bought a ready tablet.

### 2. Headscale (our own coordination server) on AWS

Same client side as 1, with the Tailscale apps pointed at `headscale.openhouse.computer` instead of Tailscale's
servers.

- **Setup for a household:** still the Tailscale app on every phone and computer, plus changing its server address
  (hidden in settings on iOS and Android), plus a sign-in we build for headscale (OIDC from our account page).
- **Costs us:** an always-on container (Fargate or a small EC2) with its database, and DERP relays of our own with
  UDP open: roughly $10–25 a month to start, plus running a VPN control plane, which is real security work.
- **Security:** our server decides who joins which household's network. A compromise of it lets an attacker add
  nodes to any household (our sealing would still keep contents and tools out of reach, but the network is open to
  them). The most attack surface for us of the three.
- **Privacy:** like Tailscale's, but we hold it: device names, addresses, online times.
- **Who it works for:** only our cloud households, and they still install a VPN app. No reason to prefer it over 1 or 3.

### 3. A relay through our cloud (no VPN)

The tablet keeps one outbound WebSocket to `relay.openhouse.computer` (API Gateway WebSocket API, a Lambda and the
existing DynamoDB table, in the same CDK stack). A phone page or the computer's MCP sends its already-sealed request to
the relay, addressed to the tablet; the relay passes the bytes down the tablet's socket; the tablet opens it exactly
as if it had arrived on the Wi-Fi (same `/s` handler, same scopes, same counters) and its sealed reply frames go back
the same way.

```
phone page / computer MCP ──wss──▶ relay.openhouse.computer (API Gateway WebSocket) ──▶ Lambda ──▶ DynamoDB (who is connected where)
                                          │  postToConnection: the sealed bytes, unopened
tablet bridge ◀──wss (dialed out, authenticated with the tablet's cloud device credential)
```

- **Setup for a household:** none beyond what they do now. A linked tablet (Settings → Account) gets a switch,
  **Use it away from home**, off until someone turns it on, or opens the Connect screen (Settings, "Connect your AI
  assistant"), which turns it on: the cloud's connector, which the setup prompt adds, reaches the tablet only through
  it. A household that never connects an assistant stays home-only. Computers and phone pages paired on the Wi-Fi then
  also work from anywhere: the computer's MCP and the list page try the Wi-Fi first and fall back to the relay.
- **How a device is allowed:** each paired device derives a relay token from its own key (HKDF, label `relay`); the tablet
  sends the relay only the tokens' hashes. The relay forwards only from a token on that tablet's list, so a stranger
  can't even reach the tablet's socket. Removing a device on the tablet removes its hash at once. No new secret to hand out.
- **Costs us:** API Gateway WebSocket is $0.25 per million connection-minutes and $1 per million messages. A tablet
  connected all month with a keepalive every 5 minutes is about 44,000 minutes and 9,000 messages: about **$0.02 a
  tablet-month**, plus Lambda (cents). A busy workshop evening is a few thousand messages. Nothing runs when idle.
  Limits to design around: 128 KB per message (screenshots are cut into frames already), 10 minutes idle and 2 hours
  per connection (the tablet pings and reconnects).
- **Security:** a stolen phone's list page key lasts 3 hours and reaches only that list page. A stolen paired laptop
  reaches the workshop tools from anywhere until someone removes it on the tablet (today: only from the Wi-Fi); that
  is the real change, so the switch stays off until someone turns it on or opens the Connect screen, and the Screens list shows when each device last came in from
  away. A stolen tablet credential lets someone pose as the tablet to the relay but not open anything a device sends.
  A compromised relay sees sealed bytes; it can drop or delay them, not read them, and not make up a request from a
  device (the counters and keys are between device and tablet). With one exception: a phone set up with Send to Opie
  (docs/phones.md) hands the cloud its share key with each share, so a compromised cloud could make up shares from
  that phone. Those reach one route only, `POST /phone/share`: a typed turn to Opie as that person, never twice the
  same, and over once the phone is removed in Settings. Nothing else a phone can do is open to it.
- **Privacy:** our servers see which tablet a paired device talks to (by random ids), when, how many bytes, and IP
  addresses. Never contents. Nothing is logged but counts; no payloads in logs.
- **Who it works for:** our-tablet cloud households, with nothing to install. Open-source self-installers deploy the
  same stack into their own AWS account (as with backups), or use Tailscale (1) on their own.

## Recommendation

**The relay (3).** It is the only one with no setup for a household, it reuses the sealing and pairing we already
trust, it costs about two cents a tablet-month, and it is the base the later pieces need anyway: the claude.ai and
ChatGPT connectors (a public https endpoint, [workshop-mcp.md](workshop-mcp.md)), push notifications (the tablet's
socket), and remote help. Tailscale stays possible later for self-installers as an "advanced" option; headscale isn't worth it.

### Smallest first version

1. **Cloud:** a WebSocket API at `relay.openhouse.computer` with one Lambda: `$connect` for tablets (device
   credential) and devices (relay token), a `send` route that looks up the tablet's connection and forwards, and
   replies back to the sender's connection. Connections and allowed token hashes in the existing table (TTL'd).
   Tested with the local server (`openhouse-cloud/lambda/local.ts` gets a WebSocket endpoint), no AWS needed.
2. **Tablet (bridge):** `bridge/relay.js`: while linked and the switch is on, keep the socket up (ping, reconnect with
   backoff, after 2 hours); hand each arriving request to the screens `/s` handler; publish the token hashes of paired
   computers (and later screens). `GET/POST /relay` for Settings.
3. **Computer:** `connect/openhouse-mcp.mjs` tries the Wi-Fi, then the relay (the address and the tablet's relay id
   arrive in the sealed welcome at pairing; computers paired before get them on their next request on the Wi-Fi).
4. **Shell:** the switch under Settings → Account, and "last from away" in Screens.
5. **Phone list pages** as a second step: the page's `/i` and `/s` fall back to the relay; the bridge passes them to
   the shell's `Handoff` on the tablet.

Left for later: remote help (a time-limited "computer" pairing for Opie support, granted on the tablet), a
browsable `https://<household>.openhouse.computer`, push notifications, the claude.ai/ChatGPT connectors.

## Decided (2026-11-19)

1. **The relay.** Tailscale stays a possible "advanced" option for self-installers later; no headscale.
2. **The first version carries** the workshop (computers), paired screens and phone list pages. Remote help later.
3. **Off until someone turns it on,** asked right after the tablet is linked ("Reach this tablet from away from
   home?" Yes / Not now, before the backups question), and changeable later under Settings → Account.

## How it's built

| Piece | Where |
| --- | --- |
| The relay | `openhouse-cloud/lambda/relay.ts` (the logic, against the Store), `relay-handler.ts` (API Gateway's WebSocket events), `ws-local.ts` (the local server's WebSockets, no packages), `openhouse-cloud/lib/stack.ts` (a WebSocket API, stage `v1`, its own throttle, an optional `relayDomain`) |
| Where tablets dial | `GET /v1/relay` → `{url}` (the stack sets `RELAY_URL`; the local server answers `ws://<its address>/relay`) |
| The tablet | `bridge/relay.js`: the socket (hello with the device credential, a ping every 4 minutes, a fresh socket before the 2-hour limit, backoff), the list of token hashes, and each arriving request handed to `screens.relayed` (the Wi-Fi's own `/s` code) or to the shell's list page |
| Device tokens | `screens.relayToken(key)`: HKDF of the device's own key, so there's nothing new to keep. Devices get theirs sealed, from `GET /relay/me` on the Wi-Fi |
| Computers and screens | `chat/src/relay-client.js` (one WebSocket, a `Response` per request), used by `screen-client.js` when the home network doesn't answer a quick check; the MCP and the screen page keep `relay` with their pairing |
| Phone list pages | `ui/Phone.kt` registers each list's page (`POST /relay/handoff`), its sealed info carries `relay`, and `assets/list.html` goes through it when the Wi-Fi misses; `Handoff.relayOrigin` widens the page's `connect-src` |
| The switch | `shell/.../CloudMenu.kt` (Use it away from home), and "from away, 3 h ago" in Screens |
| Tests | `openhouse-cloud/test/relay.test.ts`, `openhouse-cloud/test/stack.test.ts`, `bridge/test/relay.test.mjs` (the bridge, the local service and a device, end to end) |

To try it on an emulator with the local service (so the emulator and this Mac use the same relay address):

```bash
scripts/cloud.sh node lambda/local.ts --port 8797 --base http://localhost:8797
```

```bash
adb reverse tcp:8797 tcp:8797
```

Then Settings → Advanced → Cloud address → `http://localhost:8797`, link, and Account → Use it away from home → Turn on.
(Any port free on both sides; some emulator images already have something on 8790.) Tried this way on 2026-11-19: the
tablet connected and reconnected by itself after a restart; a paired computer's MCP, with its Wi-Fi path cut, ran
`about_household` and `look_at_tablet` (a screenshot, many relay messages, 0.4 s) through the relay, and Screens
showed it "from away"; a list page in a browser, with its Wi-Fi path cut, added an item that reached the tablet's list
and said "Live with the display, from away." 

Known limits of this version:
- List pages open anywhere: with this on, the list's QR code points to the same page served by the service
  (`https://cloud.openhouse.computer/l#<key>.<relay>.<token>`; `openhouse-cloud/lambda/phone-pages.ts` is a generated copy of
  the tablet's `list.html`, kept equal by a test). Everything after `#` stays on the phone, so the service never sees
  the key or token; it does see that a phone loaded the page (its address, its browser). The trust this adds: the page's
  code now comes from our server, so a compromised server could serve a page that leaks the key. The page is also all
  relay, even at home. A screen page still has to be opened at home first (it keeps working when it leaves).
- A device learns the relay the next time it talks to the tablet on the Wi-Fi with this on (computers and screens ask
  every hour while it's off, every 6 hours while it's on; a list page when it's opened).
- The computer's MCP needs a Node with a built-in WebSocket (22 and later); on an older one it stays on the Wi-Fi.
- No push notifications or remote help yet. The claude.ai and ChatGPT connector is built on the relay: [web-chat-building.md](web-chat-building.md).

## Tailscale, for households without Opie cloud

Built 2026-11-27 (branch `tailscale-away`). For a household that doesn't use Opie cloud: "fine if it's complicated".
Off until someone turns it on, it's the household's own tailnet (never ours), and it has nothing to do with the cloud:
it works on a tablet that was never linked. The tailnet is one more carrier for the same sealed requests: pairing,
scopes and counters are unchanged, and every request still has to be sealed by a paired device.

### How it's built

| Piece | Where |
| --- | --- |
| The node, sign-in, https, turning off | `bridge/tailscale.js` (`GET/POST /tailscale`, the display's own; `admin` on a hub's settings device) |
| Links and QR codes, CORS for `/s` over the tailnet | `bridge/screens.js` (`lanBase`, `overTailnet`, `pageHeaders`) |
| Paired devices learn the address | `GET /relay/me`'s `tailnet` (`bridge/relay.js`), a computer's welcome (`welcome.tailnet`) |
| Devices try it when the Wi-Fi misses | `chat/src/screen-client.js` (`tailnet`, `onTailnet`): the Wi-Fi, then the tailnet, then the relay. Screen, phone and hub pages keep it with their pairing; `connect/openhouse-mcp.mjs` too, and `pair opie.<tailnet>.ts.net <code>` pairs over it |
| Settings → Advanced → Tailscale | `shell/.../TailscaleMenu.kt`; the row is `DeviceServer.personOnly`, inside Advanced's PIN. A hub's settings page: `chat/src/hub.jsx` `Tailscale` |
| Not in backups | `.tailscale` (the node's state and key) and `.tailscale-bin` (the download): `bridge/stores.js`, and left out of `/backup/export` |
| Test | `bridge/test/tailscale.test.mjs`: over the tailnet only sealed requests, within the device's scopes; a computer's own Tailscale is never signed out |

**The node.** Tailscale's official static Linux build (`tailscale_<version>_<arch>.tgz` from pkgs.tailscale.com),
pinned by version and sha256 in `tailscale.js` (`TAILSCALE`), downloaded only when someone turns it on (about 38 MB,
73 MB unpacked), never in the runtime's tarball. The bridge runs it as its child, inside the runtime (proot Ubuntu):

```
tailscaled --tun=userspace-networking --statedir=<data>/.tailscale --socket=<data>/.tailscale/tailscaled.sock --port=0 --no-logs-no-support
```

with `TS_DEBUG_DISABLE_PORTLIST=true` (the tablet's open ports aren't sent with its details) and no log upload. It's
started again if it stops (2 s, 5 s, 15 s, then every minute), and a bridge that restarts keeps the one already
answering on its socket. Userspace networking needs no VPN slot: Android's stays free, with no key icon, and the rest of
the tablet's traffic doesn't go through it. The machine's name is `opie` (Tailscale adds `-1` if it's taken).

**Signing in.** `tailscale up --hostname=opie` prints a login URL; the tablet shows it as a QR code, and a person signs
in on their phone. Or an auth key from the admin console (Settings → Keys), pasted: it goes to `up` as
`--auth-key=file:<a 600 file>`, never on a command line, and the file is gone once `up` has it. Tailscale's own
sign-in, on Tailscale's pages: the tablet never sees a password. A tailnet that approves devices by hand shows
"Approve Opie in Tailscale". A key Tailscale refuses says so, and the QR code to sign in comes up instead.

**https.** Once the node is Running with a certificate domain (`tailscale status --json`'s `CertDomains`, there when
the tailnet has HTTPS certificates on), `tailscale serve --bg --yes --https=443 http://127.0.0.1:8788`: the home
network's port at `https://opie.<tailnet>.ts.net`, with Tailscale's own certificate, which it renews. Serve keeps the
Host, says `X-Forwarded-Proto: https` and `X-Forwarded-For: <the peer's 100.x>` (which the port counts misses by).
With HTTPS off, the address is `http://<100.x>:8788` (userspace networking passes the node's own ports on to the
tablet's loopback), and the tablet's dialog says, in one line behind More, to turn HTTPS on in the admin console under
DNS. It looks again every minute, so turning it on there is enough.

**Devices.** While it's on and up, links and QR codes for screens and phones use that address (`base`, with
`via: 'tailscale'`, and the shell's caption says "with Tailscale on"): the page's code still comes from the tablet,
and it works at home and away, whenever the phone's Tailscale is on. Devices joined before stay on the Wi-Fi's address
(their storage is that origin's), learn the tailnet address with the relay's (`GET /relay/me`, every 6 hours, on the
Wi-Fi), and send their sealed requests there when the Wi-Fi misses: CORS (`*`) is open on `/s` and the "am I home?"
check, and only for requests that came over the tailnet; the page rules (`connect-src`) name the address. A computer's
MCP gets it in its welcome and keeps it in `pairing.json`.

**A computer with Tailscale of its own** (a hub on a Mac or Linux box): `tailscale` on its PATH, or the Mac app's, is
used through the same calls instead of a download. It has to be signed in there already: Opie never signs it in
or changes its settings (no `up`). Its serve goes on the home network's port (8788), not 443, so
whatever it serves at https stays as it is; turning it off here takes only that address away (`serve --https=8788
off`), never the computer's own sign-in. A Mac with no Tailscale says to install it.

**Turning it off** (one button, behind a red "Turn off Tailscale?"): `tailscale logout` (the node leaves the tailnet's
list), tailscaled stopped, `.tailscale` and `.tailscale-bin` removed. Turning it on again is a fresh node, downloaded
and signed in again. (The plan had Turn off and Forget; with both signing out and removing the state, they'd be the
same, so it's one.)

### How to try it

On an emulator: Settings → Advanced → Tailscale → Turn on. Or, from a computer, with the bridge's secret:

```bash
adb forward tcp:9787 tcp:8787 && T=$(scripts/bridge-token.sh)
curl -H "X-Openhouse-Token: $T" -H 'content-type: application/json' -d '{"on":true}' localhost:9787/tailscale
curl -H "X-Openhouse-Token: $T" localhost:9787/tailscale   # state: getting, starting, then signin with its login URL
```

Tried on an emulator (arm64, Android 15, 2026-11-27): the download and its checksum, `tailscaled` starting in the
runtime inside the app's own sandbox (no complaint about Android's network limits), the login URL, a refused auth key,
and turning off (no process, no state, no download left). Once, on a fresh emulator, the first `tailscaled` after the
download never answered on its socket; started again it did, so the bridge now starts it again after 45 s of silence. Not tried yet: a real sign-in, the https address, a phone
over it, and a hub with its own Tailscale.

### Limits and security

- **Every port of the tablet's loopback is on its tailnet address.** Userspace networking passes any TCP connection to
  the node's 100.x address on to `127.0.0.1:<port>` (tailscale's `wgengine/netstack/netstack.go`, v1.104.7; there's no
  switch to turn that off, and `--shields-up` would turn serve off too). Any app on an Android tablet could already
  reach its loopback, so everything listening there already asks for a secret: the bridge (8787), the shell's device
  server, the backup drive's. The one that doesn't: the apps' dev server (5173) serves the household's own apps' files
  (its `/bridge` passes on to the bridge, which still asks for keys). Over the tailnet, that's the household's own
  devices. A household that wants only the https address reachable can say so in its tailnet's access controls, for
  example: `{"action": "accept", "src": ["autogroup:member"], "dst": ["opie:443"]}` in place of the default allow-all
  (with a `hosts` entry for `opie`, its 100.x address).
- **Two places to remove a lost phone or laptop:** Tailscale's admin console (else it still reaches the tablet's
  ports from anywhere) and Settings → Linked devices (else its key still opens requests). Either one alone stops it
  doing anything: without pairing it gets nothing, and without the tailnet it can't get there from away.
- **A leaked auth key** joins a stranger's machine to the household's tailnet; it still has to pair to do anything.
  Prefer the QR code, or a one-off key that expires.
- **Phones need Tailscale on at home too** for codes made while it's on (the address is the tailnet's). The Wi-Fi's
  address keeps working for devices that joined on it.
- **List and photo pages from a QR code** (the shell's `Handoff`, on the Wi-Fi's address) aren't reachable over it.
- **Opie's voice, push through the cloud, the claude.ai connector** are the cloud's; the tablet's own connector
  (`web-mcp.js`) can sit behind a Tailscale Funnel the household sets up itself.
- **Misses are counted per tailnet peer** through serve (X-Forwarded-For); over the plain 100.x address (HTTPS off)
  they all come from 127.0.0.1 and share one count.
- **Privacy:** Tailscale's coordination server sees the tablet's name (`opie`), OS, addresses and when it's online; a
  service the household chose. No logs are uploaded and no port list is sent.
- **Moving the pinned version on:** the new version's `.tgz.sha256` for arm64 and amd64 from pkgs.tailscale.com/stable,
  into `TAILSCALE` in `tailscale.js`. A tablet with it on downloads the new one (and removes the old) the next time the bridge starts.

## Still to do

Deploying: `openhouse-cloud/scripts/deploy.sh` asks once for the relay's address (`relay.openhouse.computer`), requests its own
certificate, and prints the CNAMEs for Vercel. Then the tablets need the new release.
