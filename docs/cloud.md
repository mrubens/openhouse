# The cloud service

The first slice of Opie's managed cloud: linking a tablet to a family account, encrypted backups, health
check-ins and tablet updates. Its code (AWS CDK: Lambda, API Gateway, DynamoDB, S3, CloudFront) is in a private repo of its own,
mrubens/openhouse-cloud, with its operator docs (AWS setup, deploying, releases, costs, voice). This page is what
the tablet sees of it and what it keeps.

Everything on the tablet is off until someone links it (Settings → Account).

## What it does

| | Tablet side | Service side |
|---|---|---|
| **Linking** | Settings → Account → Link shows a code and a QR code (15 minutes) | Someone signs in at `/link` with an emailed link (SES, no passwords, no Cognito) and types the code. The tablet then receives its device credential once. |
| **Device credential** | `display/.cloud/device.json` (0600). Rotated every 30 days. | Only a SHA-256 hash is stored. Revoking from the web page stops it on the next call. After a rotation the old credential keeps working until the new one is first used. |
| **Backups** | The cloud is one place backups can go; a USB drive is the other ([backups.md](backups.md)). The same encrypted file is uploaded straight to S3 with a presigned PUT. | The service keeps the newest 7 nightly and 5 manual backups per tablet. It stores ciphertext, its size, and a key id (a hash of the key). Uploads that never finish expire after 2 days. |
| **A copy of the recovery code** | Off unless someone says yes when the cloud is first turned on, or later under Backups | Kept under the family (`FAMILY#…/ESCROW#<keyId>`) only after the service checks the code fits its key id. A linked tablet of that family can fetch it to restore; the family, signed in, can see it on the family's page; turning it off deletes it. |
| **Health** | Every 5 minutes, sent by the shell (so a stuck bridge is reported too) | Only the latest check-in is kept per tablet. It shows on the family's page and in the operator's `admin.ts tablets`. |
| **Updates** | Built by the self-update work, against the manifest below | `GET /v1/update`, with releases on S3 behind CloudFront and rollout by percentage |
| **The website** | | openhouse.computer: the landing page, and a form to ask for a beta invite (an email and two optional answers, kept in the table) |

### Backups

What a backup holds, how it's locked, and where it can go (the cloud, a USB drive, later a home computer's shared
folder) are in [backups.md](backups.md). The cloud's part: presigned uploads and downloads, keeping the newest
few, and the optional copy of the family's recovery code.

### Health check-ins carry no family content

The fields are: version name and code, uptime, whether the bridge answers, whether the assistant answers, agent,
model, free bytes, the last error's *type* (for example `backup.uploading`; never its text) and whether backups are
on. The service checks each field's shape (`cleanHealth` in the service) and drops anything else, so
free text can't get through even from a buggy tablet.


## The cloud repo and its commands

The service is in mrubens/openhouse-cloud, a private repo for the hosted service, checked out at
`~/Code/openhouse-cloud` (or `OPENHOUSE_CLOUD`, or an `openhouse-cloud` folder next to this repo). Its README has
every command; `scripts/cloud.sh <command>` runs one there with `OPENHOUSE` set to this checkout, so the copies it
keeps of our pages are rebuilt from here. Give files from this repo as absolute paths.

- **Deploy** (the deploy settings, not secret, are its `cdk.context.json`, copied in from
  `~/.openhouse/cloud/cdk.context.json` when it has none):

  ```bash
  AWS_PROFILE=openhouse-admin scripts/cloud.sh scripts/deploy.sh --diff
  ```

  ```bash
  AWS_PROFILE=openhouse-admin scripts/cloud.sh scripts/deploy.sh
  ```

- **Publish a release** `scripts/release.sh` built, or a voice set (`scripts/voice-bundle.sh`):

  ```bash
  AWS_PROFILE=openhouse-admin scripts/cloud.sh node scripts/release.ts "$PWD/dist/<version>/display.apk" --rescue "$PWD/dist/<version>/rescue.apk" --channel stable
  ```

  ```bash
  AWS_PROFILE=openhouse-admin scripts/cloud.sh node scripts/release.ts --voice ~/.openhouse/voice/<n>
  ```

- **After changing the phone page** (`chat/src/phone.jsx` and its files) or `shell/app/src/main/assets/list.html` /
  `share.html`: rebuild the service's copy, then commit it in the cloud repo and deploy. Its tests fail until the
  copy matches.

  ```bash
  scripts/cloud.sh node scripts/phone-app.ts
  ```

  ```bash
  scripts/cloud.sh node scripts/phone-pages.ts
  ```

- **The relay protocol** (`bridge/relay.js`, `bridge/screens.js`, `chat/src/relay-client.js` here; `lambda/relay.ts`,
  `connector.ts`, `send.ts` there) changes on both sides together. The bridge's end-to-end tests
  (`bridge/test/cloud.test.mjs`, `connector`, `relay`, `send-to-opie`) run the service locally from the cloud checkout
  (`bridge/test/cloud-service.mjs`) and are skipped without one; the cloud's tests check its pairing and sealing
  against `bridge/pair-code.js` and `bridge/screens.js` here.
