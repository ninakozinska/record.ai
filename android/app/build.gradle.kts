plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "ai.record.android"
    compileSdk = 35

    defaultConfig {
        // The app's permanent name in Google Play. It can never change once the
        // app is published, and must match the app made in Play Console.
        applicationId = "com.ninakozinska.recordai"
        minSdk = 26
        targetSdk = 35
        // Raise versionCode by 1 for every upload to Google Play; versionName is what people see.
        versionCode = 1
        versionName = "1.0.0"
    }

    // The upload key for Google Play (docs/ReleaseAppStore.md, "Android").
    // Never in the repository: it comes from ~/.gradle/gradle.properties or
    // environment variables (GitHub secrets in the "Android release" workflow).
    val secret = { name: String -> providers.gradleProperty(name).orElse(providers.environmentVariable(name)).orNull }
    val uploadKeystore = secret("SORTMEMO_UPLOAD_STORE_FILE")
    signingConfigs {
        if (uploadKeystore != null) create("upload") {
            storeFile = file(uploadKeystore)
            storePassword = secret("SORTMEMO_UPLOAD_STORE_PASSWORD")
            keyAlias = secret("SORTMEMO_UPLOAD_KEY_ALIAS")
            keyPassword = secret("SORTMEMO_UPLOAD_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            // Smaller, faster app: remove unused code and resources (rules in proguard-rules.pro).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // With the upload key set up: signed for Google Play. Without it (tests,
            // trying it on your own phone): signed with the debug key, which Google
            // Play refuses, so a wrongly signed upload can't happen by accident.
            signingConfig = if (uploadKeystore != null) signingConfigs.getByName("upload") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
}
