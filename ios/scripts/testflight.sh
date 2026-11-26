#!/bin/bash
# Archives the iPhone app from this checkout and uploads it to App Store Connect (TestFlight's Household group gets it
# by itself). Needs ios/Config/Local.xcconfig with DEVELOPMENT_TEAM, and an App Store Connect API key with Admin access
# (cloud signing): ~/.appstoreconnect/AuthKey_<id>.p8 and ~/.appstoreconnect/config with ASC_KEY_ID and ASC_ISSUER_ID.
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.appstoreconnect/config
team=$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' Config/Local.xcconfig)
out=$(mktemp -d)
auth=(-allowProvisioningUpdates -authenticationKeyPath ~/.appstoreconnect/AuthKey_$ASC_KEY_ID.p8
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
build=$(date +%Y%m%d%H%M)
xcodebuild archive -project OpenHouse.xcodeproj -scheme OpenHouse -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$out/Opie.xcarchive" CURRENT_PROJECT_VERSION="$build" "${auth[@]}" -quiet
cat > "$out/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string><key>destination</key><string>upload</string>
<key>teamID</key><string>$team</string><key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$out/Opie.xcarchive" -exportOptionsPlist "$out/export.plist" -exportPath "$out/export" "${auth[@]}" -quiet
echo "Uploaded build $build"
