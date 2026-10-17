// record.ai for Android.
//  - core: data, sync and server connection (plain Kotlin, tested on any computer)
//  - app:  the Android screens (needs the Android SDK, e.g. Android Studio)
pluginManagement {
    repositories {
        maven("https://maven.google.com") // Google's Android repository
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        maven("https://maven.google.com") // Google's Android repository
        mavenCentral()
    }
}

rootProject.name = "record.ai"
include(":core")

// The app module needs the Android SDK. Without it (for example on a build
// server that only runs the core tests) only :core is built.
val sdkDir = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
    ?: file("local.properties").takeIf { it.exists() }?.readLines()
        ?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")
if (sdkDir != null && file(sdkDir).exists()) include(":app")
