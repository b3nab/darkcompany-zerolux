# Mobile app

The ZeroLux app for iPhone and Android: the same workspace as the web, with Tonight, the
Console, chats, the organization and settings, drawn with each system's own controls. It talks
to a kernel over HTTP on your local network, or over HTTPS elsewhere, and receives updates in
real time.

## Connect to a kernel

The app asks where your kernel is. On the same network, start the kernel with
`--expose <ip>`, the address of that computer on the network, and enter
`http://<ip>:4310`. For a workspace elsewhere, enter its HTTPS address. Invited by someone?
Paste the invitation link they sent instead: the app joins their workspace. When the kernel
serves several workspaces, the app lists them to choose one.

## Workspaces

The app keeps every workspace you add, each with its own sign-in, and opens one at a time. The
mark at the top left of Tonight, Console, Chats and Org lists them, with what waits in the
others: requests to decide and chats with unread messages. Tonight shows those under
Elsewhere. **Add workspace** connects another one; holding a workspace renames it on this
phone, signs out of it or removes it from the phone. Notifications name their workspace when
the app keeps more than one, and a tap opens it.

## Android

Each release has `zerolux-<version>-android-arm64.apk`, for 64-bit ARM phones. Download it on
the phone and open it; Android asks once to allow installing apps from that source.

## iPhone

Build it with Xcode on a Mac, from the repository:

```sh
bun install --frozen-lockfile
cd apps/mobile
bun x --bun expo prebuild --platform ios --no-install
cd ios && pod install
open ZeroLux.xcworkspace
```

In Xcode, choose the **ZeroLux** scheme and your iPhone, set your team under **Signing &
Capabilities**, and run it. A free Apple ID signs it for your own phone for seven days, after
which you build it again; an Apple Developer Program membership signs it for a year. The first
time, trust your developer certificate on the iPhone in **Settings › General › VPN & Device
Management**.

## Android from source

You need JDK 17 and the Android SDK, with `ANDROID_HOME` set.

```sh
bun install --frozen-lockfile
cd apps/mobile
bun x --bun expo prebuild --platform android --no-install
cd android
# Expo's template packs the Gradle wrapper so Java cannot open it: Gradle writes it again.
version="$(sed -n 's/.*gradle-\(.*\)-bin\.zip/\1/p' gradle/wrapper/gradle-wrapper.properties)"
java -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain wrapper --gradle-version "$version"
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install app/build/outputs/apk/release/app-release.apk
```

## Development

The app needs a development build, not Expo Go. Build one for a simulator, an emulator or a
phone as above with the **Debug** configuration (`./gradlew assembleDebug` on Android), then
run Metro from `apps/mobile`:

```sh
bun x --bun expo start --dev-client
```
