plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    // Package IDs from shell/gradle.properties (openhouse.appId).
    val appId = findProperty("openhouse.appId") as String
    namespace = "dev.openhouse.shell"
    compileSdk = 35
    defaultConfig {
        applicationId = "$appId.shell"
        minSdk = 29
        targetSdk = 35
        // A release (scripts/release.sh) passes its version: -Popenhouse.version=1.2.3 makes versionCode 1_02_03_00
        // (Releases.versionCode); its rescue build passes -Popenhouse.versionCode=<release's + 1>. Builds for a
        // computer stay at 1, below every release, so a tablet set up over USB takes the first update it's offered.
        val v = (findProperty("openhouse.version") as String?)
        versionName = v ?: "0.1-dev"
        versionCode = (findProperty("openhouse.versionCode") as String?)?.toInt()
            ?: v?.let { val (a, b, c) = it.split('.').map(String::toInt); a * 1_000_000 + b * 10_000 + c * 100 } ?: 1
        // Where the display looks for updates (docs/self-update.md); adb can set another (ConfigReceiver update_url).
        buildConfigField("String", "UPDATE_URL", "\"${findProperty("openhouse.updateUrl") ?: ""}\"")
        // The listening models' set (VoiceModels.kt, docs/voice-models.md); adb can set another (ConfigReceiver voice_url).
        buildConfigField("String", "VOICE_URL", "\"${findProperty("openhouse.voiceUrl") ?: ""}\"")
        buildConfigField("String", "HOST_PKG", "\"$appId.host\"")
        buildConfigField("String", "AGENT_PKG", "\"$appId.agent\"") // the old assistant's own app, removed on update (OldAgent.kt)
        buildConfigField("String", "APP_PREFIX", "\"$appId.app.\"")
        // Moving a tablet off the old IDs (Move.kt): built under the old ID with -Popenhouse.moveTo=<new ID>, a display
        // hands over to the app with that ID signed with the release key; under the new ID it takes over from movedFrom.
        val movedFrom = (findProperty("openhouse.movedFrom") as String?).orEmpty()
        buildConfigField("String", "MOVED_FROM", "\"${if (movedFrom == appId) "" else movedFrom}\"")
        buildConfigField("String", "MOVE_TO", "\"${(findProperty("openhouse.moveTo") as String?).orEmpty()}\"")
        buildConfigField("String", "RELEASE_CERT", "\"${(findProperty("openhouse.releaseCert") as String?).orEmpty().lowercase().replace(":", "")}\"")
    }
    // What a release may download and run, by SHA-256 (Pinned.kt): the Linux runtime and the voice set's voice.json,
    // from shell/gradle.properties (scripts/release.sh checks them, and passes a new runtime's). Debug builds carry
    // none and take whatever runtime or voice set they're given.
    fun pin(name: String): String {
        val v = (findProperty(name) as String?).orEmpty().trim().lowercase()
        require(v.isEmpty() || Regex("^[0-9a-f]{64}$").matches(v)) { "$name isn't a SHA-256: $v" }
        return v
    }
    val runtimePin = pin("openhouse.runtimeSha256")
    val voicePin = pin("openhouse.voiceSha256")
    buildTypes {
        // testOnly lets `dpm remove-active-admin` undo device owner on a tablet set up over USB. A release can't be
        // testOnly: Android won't install one from the display's own installer (self-update) or from a QR code.
        debug {
            manifestPlaceholders["testOnly"] = "true"
            buildConfigField("String", "RUNTIME_SHA256", "\"\"")
            buildConfigField("String", "VOICE_SHA256", "\"\"")
        }
        // Unsigned: scripts/release.sh signs it with the release key (and the lineage from the debug key).
        release {
            isMinifyEnabled = false; signingConfig = null; manifestPlaceholders["testOnly"] = "false"
            buildConfigField("String", "RUNTIME_SHA256", "\"$runtimePin\"")
            buildConfigField("String", "VOICE_SHA256", "\"$voicePin\"")
        }
    }
    lint { checkReleaseBuilds = false }
    testOptions { unitTests.isReturnDefaultValues = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true; buildConfig = true }
    // proot is shipped as lib*.so so Android installs it executable (app data dirs are noexec).
    packaging { jniLibs { useLegacyPackaging = true } }
    defaultConfig { ndk { abiFilters += "arm64-v8a" } }
}

// The template each family app's installed Android app is made from (AppStubs.kt): the :stub module's APK, as an asset.
val stubAssets = layout.buildDirectory.dir("generated/stubAssets")
val copyStub = tasks.register<Copy>("copyStubTemplate") {
    dependsOn(":stub:assembleRelease")
    from(project(":stub").layout.buildDirectory.file("outputs/apk/release/stub-release.apk")) { rename { "stub-template.apk" } }
    into(stubAssets)
}
// The update cover (:host, HostApp.kt), carried too: a tablet set up from the QR code gets it from the display, as
// owner, with no adb. A release carries it signed with the release key (scripts/release.sh passes it).
val hostAssets = layout.buildDirectory.dir("generated/hostAssets")
val copyHost = tasks.register<Copy>("copyHostApk") {
    val signed = findProperty("openhouse.hostApk") as String?
    if (signed != null) from(signed) { rename { "host.apk" } }
    else { dependsOn(":host:assembleDebug"); from(project(":host").layout.buildDirectory.file("outputs/apk/debug/host-debug.apk")) { rename { "host.apk" } } }
    into(hostAssets)
}
android.sourceSets.getByName("main").assets.srcDir(stubAssets)
android.sourceSets.getByName("main").assets.srcDir(hostAssets)
// The live voice session page, one copy for the tablet and the browsers (chat/live/live-session.cjs, LiveVoice.kt).
android.sourceSets.getByName("main").assets.srcDir("../../chat/live")
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(copyStub, copyHost) }
tasks.matching { it.name.startsWith("lintVital") || it.name.startsWith("generate") && it.name.endsWith("LintModel") }.configureEach { dependsOn(copyStub, copyHost) }

// A release without its checksums could never set a tablet up (or get its voice set): it isn't built.
val releasePins = Triple(
    (findProperty("openhouse.runtimeSha256") as String?).orEmpty(),
    (findProperty("openhouse.voiceUrl") as String?).orEmpty(),
    (findProperty("openhouse.voiceSha256") as String?).orEmpty())
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        val (runtime, voiceUrl, voice) = releasePins
        require(runtime.isNotBlank()) { "a release needs openhouse.runtimeSha256 (shell/gradle.properties)" }
        require(voiceUrl.isBlank() || voice.isNotBlank()) { "a release with openhouse.voiceUrl needs openhouse.voiceSha256" }
    }
}

dependencies {
    implementation("com.android.tools.build:apksig:8.7.3") // signs each family app's installed APK on the device (AppStubs)
    implementation("com.google.zxing:core:3.5.3") // QR code for the sign-in link
    // Compose, for the overlay (the assistant's note, typing, conversations, settings). The home screen and the family's
    // apps are web pages (HomeView, AppWindow).
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.3")
    // The camera, for Opie's look_with_camera after a person taps Allow (CameraLook.kt): preview and one picture.
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303") // Android's org.json, for Releases' tests on the computer
}
