# Reaching the tablet from away from home

Status: the relay's first version is built (workshop computers, paired screens, phone list pages), tested end to end
against the local service and on an emulator. Not deployed: `relay.openhouse.computer` waits on a `cdk deploy` and a
CNAME. Decisions and what's left: the end of this page.

## What needs it

| What | Today | Away from home |
| --- | --- | --- |
| The workshop MCP (`bridge/workshop.js`, `connect/`, [workshop-mcp.md](workshop-mcp.md)) | Paired computers reach `:8788` on the Wi-Fi (`openhouse.local`, Bonjour `_openhouse._tcp`) | Doesn't connect |
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

## The three ways

### 1. Tailscale on the tablet

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

Left for later: remote help (a time-limited "computer" pairing for OpenHouse support, granted on the tablet), a
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

## Still to do

Deploying: `openhouse-cloud/scripts/deploy.sh` asks once for the relay's address (`relay.openhouse.computer`), requests its own
certificate, and prints the CNAMEs for Vercel. Then the tablets need the new release.
