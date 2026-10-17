// Build plugins. The Android plugin is only loaded where the Android SDK is
// installed (Android Studio, CI); elsewhere only the :core module builds.
buildscript {
    val hasAndroidSdk = (System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
        ?: file("local.properties").takeIf { it.exists() }?.readLines()
            ?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("="))
        ?.let { file(it).exists() } == true
    repositories {
        maven("https://maven.google.com")
        mavenCentral()
        gradlePluginPortal()
    }
    dependencies {
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21")
        classpath("org.jetbrains.kotlin:kotlin-serialization:2.0.21")
        classpath("org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.0.21")
        if (hasAndroidSdk) classpath("com.android.tools.build:gradle:8.9.1")
    }
}
