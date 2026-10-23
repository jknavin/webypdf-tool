# WebyPDF – Android app (APK project)

A native Android wrapper around the WebyPDF website. All 17 PDF tools work **offline** and nothing is uploaded
(the app does not even request the INTERNET permission). Downloads are saved to **Downloads/WebyPDF**.

- Package: `com.webypdf.app` · min Android 7.0 (API 24) · target API 34
- No third-party libraries — just the Android WebView. The website lives in `app/src/main/assets/www`.

## Option A — Get the APK with no software installed (GitHub Actions, free)
1. Create a new GitHub repository and upload **everything in this folder** (73 files, so it fits GitHub's 100-file limit in one go; keep the `.github` folder). If your browser skips the hidden `.github` folder, add it afterwards: *Add file ▸ Create new file*, name it `.github/workflows/build-apk.yml` and paste in the contents of that file.
2. Open the repo → **Actions** → *Build APK* → **Run workflow** (it also runs on every push).
3. When it finishes (~3–5 min), open the run and download the **WebyPDF-apk** artifact (a zip containing
   `app-debug.apk` and `app-release.apk`). Copy the APK to your phone and install it.

## Option B — Android Studio
1. Install Android Studio (Koala or newer) → *Open* → select this folder.
2. Let Gradle sync (it downloads Gradle 8.9 + Android SDK 34 on first run).
3. **Build ▸ Build APK(s)** — or press ▶ to run on a phone/emulator.
   The APK is in `app/build/outputs/apk/debug/app-debug.apk`.

## Option C — Command line
Requires JDK 17 and the Android SDK (set `ANDROID_HOME`, or create `local.properties` with `sdk.dir=/path/to/sdk`).
```
gradle assembleDebug        # or ./gradlew after running: gradle wrapper --gradle-version 8.9
```

## Installing on your phone
Open the APK → allow "Install unknown apps" for the app you used to open it (Files/Chrome) → Install.

## Signed release build (for Play Store / updates over the same app)
```
keytool -genkeypair -v -keystore webypdf.jks -alias webypdf -keyalg RSA -keysize 2048 -validity 10000
```
Create `keystore.properties` next to `settings.gradle`:
```
storeFile=webypdf.jks
storePassword=YOUR_PASSWORD
keyAlias=webypdf
keyPassword=YOUR_PASSWORD
```
Then run `gradle assembleRelease` (or `bundleRelease` for a Play Store .aab).
**Back up the .jks file and passwords** — you can only update the app with the same key.
Without `keystore.properties` the release build is signed with the debug key (fine for personal use).

## Updating the website inside the app
Edit the website, then run `./sync-web.sh ../webypdf` (Windows: `sync-web.bat ..\webypdf`) and rebuild.
Bump `versionCode` / `versionName` in `app/build.gradle` for each new release.

## Note
To stay under GitHub's 100-file upload limit, the optional pdf.js character-map files (only needed for old PDFs with
non-embedded Chinese/Japanese/Korean fonts) are not bundled in the app. Everything else is included.

## How it works
- `MainActivity.java` serves `assets/www` over a virtual https origin (`appassets.androidplatform.net`), so ES modules,
  Web Workers, WebAssembly and localStorage behave exactly as on the website.
- WebViews cannot download `blob:` files, so the page calls the native `window.WebyAndroid` bridge, which streams the
  file in chunks into Downloads/WebyPDF (MediaStore on Android 10+; legacy storage permission on Android 9 and older).
- The system file picker handles "choose file" buttons; the Back button navigates between tools before exiting.
