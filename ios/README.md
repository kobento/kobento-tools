# Kobento showcases for iOS

An iPhone and iPad app that plays the Kobento showcases (`SHW-*` in kobento-mcp's example catalog)
with Kobento's C++ player, Skia on Metal. It is the iOS twin of the Android app in `../android`.

Three tabs:

- **Showcases**: a gallery of the showcases with their renders. A showcase fills the screen and is
  laid out again on rotation or resize; a watch face, a square document or a 4×1 widget is shown at
  its own shape. Looks: Auto (follows the system's light or dark), Light, Dark, and the mono light
  and mono dark documents. The details panel has the size, operations, design size, form, how it
  repaints, what it shows off and its summary.
- **Stream**: the documents people shared on mcp.kobento.dev, newest or top first, filtered by tag
  or searched (titles, people, tags). Tap one to play it; signed in, vote it up or down, or (its ⋯
  menu) report it or block its author.
- **Your pages**: sign in to a Kobento account to play the pages you published, and share one to
  the stream (its share button: a name and tags; the first time, your public name too), or rename,
  retag or take it out again. Under the sign-in row: **People you blocked** (Unblock) and **Delete
  account**, which deletes the account and everything in it on the server, for good.

## Build

Needs Xcode 15+ (iOS 17 SDK), xcodegen (`brew install xcodegen`; build.sh installs it), the engine
libraries from kobento-ios's `ios/` build, and kobento-ios and kobento-mcp checked out next to
kobento-tools (the showcases are copied from kobento-mcp's `examples/` at build time).

```sh
(cd ../../kobento-ios/ios && ./build.sh sim)   # the engine, Skia bridge and Skia for the Simulator: output-sim/
(cd ../../kobento-ios/ios && ./build.sh)       # ... and for a device: output/
./build.sh                      # xcodegen, then a Simulator build (iPhone 17 Pro)
open KobentoShowcases.xcodeproj # pick a device or a Simulator, set a signing team for a device, ⌘R
```

`DEST='generic/platform=iOS' ./build.sh` builds for a device. The libraries are arm64 only (a device,
or the Simulator on an Apple silicon Mac).

### For the App Store

Bump `CURRENT_PROJECT_VERSION` in project.yml for each upload (and `MARKETING_VERSION` for a new
version), build the device libraries, then archive with your team and upload from Xcode's
Organizer (Distribute App, App Store Connect):

```sh
(cd ../../kobento-ios/ios && ./build.sh)
xcodegen generate
xcodebuild -project KobentoShowcases.xcodeproj -scheme KobentoShowcases -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/KobentoShowcases.xcarchive \
  DEVELOPMENT_TEAM=<your team id> CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates archive
open build/KobentoShowcases.xcarchive
```

`Sources/PrivacyInfo.xcprivacy` is the privacy manifest (no tracking; the email and what you post,
for the app to work); the App Store's privacy answers should match it. `ITSAppUsesNonExemptEncryption`
is NO (HTTPS only).

To open one showcase, a tab or a look at launch (tests, screenshots):

```sh
xcrun simctl launch booted dev.kobento.showcases -showcase SHW-23 -look "Mono dark" -info YES
xcrun simctl launch booted dev.kobento.showcases -tab stream
```

## The player

`Sources/Player/KBPlayer.mm` plays one document with the C++ engine (rccore) and its Skia paint
context (rcskia), drawing straight into an `MTKView`'s drawable with Skia's Metal backend:

- **Laid out in points.** The document gets the view's size in points (dp, as the web and C++
  players read a document) and the canvas is scaled by the screen's scale, so it fills the view at
  any size and stays sharp. It is laid out again every frame at the view's current size.
- **Full speed.** The view draws at the screen's maximum rate (120 Hz on ProMotion;
  `CADisableMinimumFrameDurationOnPhone`) while the document animates, and stops drawing when it
  does not (a touch, a resize or a new look wakes it).
- **3D** (Kobento's 3D extension, which the androidx player does not have) is drawn by the software
  rasterizer at 2× the document's resolution (`SkiaPaintContext::setSupersample3D`), so it is not a
  1× picture scaled up next to sharp 2D.
- **Theme.** Light or dark goes into the document's data pass; changing it restarts the document.
- **Battery.** The device's battery level and power state go to the document (a watch face's ring).

## Sign in

**Sign in** on the Your pages tab (or a vote on the Stream tab) opens mcp.kobento.dev's own sign-in
page in an `ASWebAuthenticationSession`. It shares Safari's cookies, so someone already signed in on
the website only sees the "Allow" page; otherwise they sign in once (an emailed link, an account
token, or a new account).

The app is an OAuth 2.1 public client of the server (RFC 8252, `Sources/Account/Account.swift`), the
same as the Android app: it registers itself the first time (dynamic client registration, "Kobento
showcases (iOS)"), signs in with PKCE, and gets the answer back on its scheme,
`dev.kobento.showcases:/oauth`. The refresh token (30 days, rotated on each use) is in the Keychain
(this device only); the access token (1 h) is in memory. **Sign out** revokes the grant on the
server. Your pages come from `GET <server>/deploy/pages.json`, the stream from
`GET <server>/examples/stream/items.json`, and votes and shares are `POST`s under
`<server>/examples/stream/<page id>/`, all with the access token.

The server is `KOBENTO_SERVER` in project.yml (`https://mcp.kobento.dev`), or `-server <url>` at
launch for that launch only (a plain launch is back on the default, signed out of the other one).
Plain HTTP is allowed to localhost only. The Simulator reaches the Mac's localhost directly.

## Test

`UITests/AccountFlowTests.swift` drives the account flow against a local server (kobento-mcp's
examples and deploy servers behind one origin, `http://localhost:8899`): sign in through the
server's page (with a test account's token), share a page (setting the public name), vote on it in
the stream, take it out. It needs a test account with a published page and no public name yet.
`testReportBlockAndDelete` reports another account's item, blocks and unblocks its author, and
deletes the account it signed in with: give it a throwaway account's token as
`TEST_RUNNER_KOBENTO_DELETE_TOKEN`, with another account's two items in the stream.

```sh
TEST_RUNNER_KOBENTO_TOKEN=rc_... TEST_RUNNER_KOBENTO_SERVER=http://localhost:8899 \
  xcodebuild test -project KobentoShowcases.xcodeproj -scheme KobentoShowcases \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```
