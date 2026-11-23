plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The update cover: a plain screen the display puts up while it's being reinstalled (scripts/install-display.sh).
android {
    // Package IDs from shell/gradle.properties (openhouse.appId).
    val appId = findProperty("openhouse.appId") as String
    namespace = "dev.openhouse.host"
    compileSdk = 35
    defaultConfig {
        applicationId = "$appId.host"
        buildConfigField("String", "DISPLAY_PKG", "\"$appId.shell\"")
        manifestPlaceholders["displayPkg"] = "$appId.shell"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}
