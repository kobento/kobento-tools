# Kobento showcases for Android

An Android app that plays the Kobento showcases (`SHW-*` in kobento-mcp's example catalog) with the
androidx RemoteCompose player, `androidx.compose.remote:remote-player-view`.

Three tabs:

- **Showcases**: a gallery of the showcases with their renders.
- A player screen for each one: the document fills the screen and is laid out again on rotation or
  resize. A watch face, a square document or a 4×1 widget is shown at its own shape.
- Looks: Auto (follows the system's light or dark), Light, Dark, and the mono light and mono dark
  documents.
- **Stream**: the documents people shared on mcp.kobento.dev, newest or top first, filtered by
  tag or searched (titles, people, tags). Tap one to play it; signed in, vote it up or down,
  or (its ⋮ menu) report it or block its author.
- **Your pages**: sign in to a Kobento account to play the pages you published, and share one
  to the stream (its share button: a name and tags; the first time, your public name too), or
  rename, retag or take it out again. Under the sign-in row: **People you blocked** (Unblock) and
  **Delete account**, which deletes the account and everything in it on the server, for good.

## Build

The showcases are copied from a kobento-mcp checkout next to kobento-tools, or the one `KOBENTO_MCP`
names. Builds need JDK 17+ and the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`).

```sh
git clone https://github.com/camaelon/kobento-mcp ../../kobento-mcp   # if not there already
./gradlew installDebug          # build and install on a connected device or emulator
./gradlew assembleRelease       # app/build/outputs/apk/release/ (signed with the debug key)
```

### For Google Play

Play takes an app bundle signed with your upload key (Play App Signing keeps the real signing
key). Make the key once, in `android/`, and keep it and its passwords out of git:

```sh
keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Then `android/keystore.properties`:

```properties
storeFile=upload.jks
storePassword=...
keyAlias=upload
keyPassword=...
```

```sh
./gradlew bundleRelease -PversionCode=2   # app/build/outputs/bundle/release/app-release.aab
```

`keystore.properties`, `*.jks` and `*.keystore` are ignored. Each upload needs a higher
`versionCode` (`-PversionName=1.1` sets the shown version).

To open one showcase directly:
`adb shell am start -n dev.kobento.showcases/.MainActivity --es showcase SHW-23`

## Sign in

**Sign in** on the Your pages tab (or a vote on the Stream tab) opens mcp.kobento.dev's own sign-in page in a Custom Tab.
Someone already signed in on the website in that browser only sees the "Allow" page; otherwise
they sign in once (an emailed link, an account token, or a new account). Your pages then lists
the pages the account published with Kobento's MCP tools, each played like a showcase (its
`.rc`, from the page's public link).

The app is an OAuth 2.1 public client of the server (RFC 8252, `Account.kt`): it registers
itself the first time (dynamic client registration), signs in with PKCE, and gets the answer
back on its own scheme, `dev.kobento.showcases:/oauth`. It keeps the access token (1 h) and the
refresh token (30 days, rotated on each use) in its private preferences. **Sign out** revokes the
grant on the server. You can also disconnect the app under Connected apps on the account page.
Your pages come from `GET <server>/deploy/pages.json` with the access token; the stream from
`GET <server>/examples/stream/items.json` (public; with the token it adds your votes), and a
vote is `POST <server>/examples/stream/<page id>/vote` with the token, and sharing is
`POST .../stream/<page id>/post` (or `/remove`). Reporting is `POST .../stream/<page id>/report`
(reason, note), blocking `POST .../stream/authors/<author_id>/block` (or `/unblock`, and
`GET .../stream/blocked.json`), and deleting the account `POST <server>/account/me/delete` with
`confirm=delete`.

The server is `https://mcp.kobento.dev`, or `-PkobentoServer=...` at build time. To test against
a local server (kobento-mcp's examples and deploy servers behind one origin), forward the port
and name it at launch. The name holds for that launch only: a plain launch is back on the
default server, signed out of the other one. Debug builds allow plain HTTP to `localhost` only.

```sh
adb reverse tcp:8899 tcp:8899
adb shell am start -n dev.kobento.showcases/.MainActivity --es server http://localhost:8899
```

## Which player

The app uses androidx-main's player: `1.0.0-SNAPSHOT`, from the androidx.dev build that
`gradle.properties` pins (`androidxSnapshotBuild`). To move to a newer one, set that property to the
id of https://androidx.dev/snapshots/latest. To use a release from Google Maven instead, pass its
version: `./gradlew -PremoteVersion=1.0.0-alpha23 installDebug`.

The player's API is `@RestrictTo(LIBRARY_GROUP)` in the alphas, so the `RestrictedApi` lint check is
off.

To try a player built from a local androidx checkout (a change under review), publish its three
modules as a snapshot and point the app at that repository. `-Pplayer3D=true` also plays the
showcases that draw in 3D instead of showing them as "Not playable here", for a player with the 3D
change (https://android-review.googlesource.com/c/platform/frameworks/support/+/4256202, with which
all six play):

```sh
# in the androidx checkout (frameworks/support): out of the way of the main OUT_DIR
SNAPSHOT=1 OUT_DIR=$HOME/androidx/out-3d DIST_DIR=$HOME/androidx/out-3d/dist ./gradlew \
  :compose:remote:remote-core:publish :compose:remote:remote-player-core:publish \
  :compose:remote:remote-player-view:publish
# here
./gradlew installDebug -PlocalRemoteRepo=$HOME/androidx/out-3d/dist/repository -Pplayer3D=true
```

## Frame rate

The player's frame budget is off. Its defaults (60 fps at most, 10 fps on average over a 10 s
window) keep a launcher's widgets cheap, but a demo slows to 10 fps after ten seconds. The app
raises both limits to the display's refresh rate, and turns off the player's Choreographer path,
which drew one frame every two vsyncs. On the emulator SHW-26 went from 9 to about 50 fps and SHW-12
to 60; a document that waits for something (a clock's next minute, a touch) still sleeps.

## Density

The showcases have no density header: `densityBehavior` needs API level 8, and they are level 7.
The androidx player lays out a document like that in pixels. The showcases are written in dp, and
the web and C++ players read them that way. `DpHost` therefore gives the player the screen's size in
dp and scales the view up by the display density. Drawing stays sharp, and touches are mapped back
into the document's coordinates. The player itself is made with a context of density 1: androidx
scales `widthIn` and `heightIn` (and dp widths) by its context's density, which on top of the view's
scaling made a 48 dp minimum 126 dp tall at 2.625.

## What plays

As of androidx.dev build 16844723 (2026-11-05):

| | Showcases |
| :--- | :--- |
| Play | SHW-04, 10, 12, 21, 22, 29, 31, 32 |
| Play until a day is picked, then throw | SHW-24, SHW-30: an animated `FloatExpression` is evaluated without arrays (`FloatExpression.updateVariables`) |
| Play, but take no drag | SHW-28: an action setting a variable to `touchX()` is dropped (`CoreDocument.evaluateFloatExpression`) |
| The player throws | SHW-23 (`ParticlesCompare.condition1Body`: a null array), SHW-25 (`PathGenerator`: path buffers sized `n * 10`), SHW-26 and SHW-27 (a computed NaN taken for an operator in `AnimatedFloatExpression.opEval`: index −1) |
| Kobento's 3D extension, not in androidx | SHW-15, 16, 17, 18, 19, 20: shown as "Not playable here" (Play anyway tries) |

These are bugs in the player: SHW-23 to SHW-28 are byte-identical to the output of androidx's own
JSON parser. kobento-mcp's `docs/EXAMPLES_FINDINGS.md` records each one (U86 to U90) with its fix;
with those five fixes applied to remote-core, every showcase above plays.

The particle showcases (SHW-10, 12, 23) create their particle systems inside an `impulse`: the
players (androidx's, and Kobento's, which follow it) re-create the particles every time
`createParticles` paints, so as a plain command they would be reset every frame (U85).
