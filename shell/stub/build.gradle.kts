plugins { id("com.android.application") }

// The template every family app is installed from (see app/.../AppStubs.kt). The shell patches its
// package name, label, app id and icon, re-signs it and installs it. Plain Java with no libraries:
// at run time it loads the shell's own code (AppWindow), so it never needs updating.
android {
    // Package IDs from shell/gradle.properties (openhouse.appId).
    val appId = findProperty("openhouse.appId") as String
    namespace = "dev.openhouse.stub"
    compileSdk = 35
    defaultConfig {
        applicationId = "$appId.app.stubtemplate"
        buildConfigField("String", "DISPLAY_PKG", "\"$appId.shell\"")
        manifestPlaceholders["displayPkg"] = "$appId.shell"
        minSdk = 29
        targetSdk = 35
        versionCode = 1 // bump when this template changes: installed stubs are replaced
        versionName = "1"
    }
    buildTypes { release { isMinifyEnabled = false; isShrinkResources = false; signingConfig = signingConfigs.getByName("debug") } }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
