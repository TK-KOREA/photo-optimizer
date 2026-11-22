plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tkkorea.photooptimizer"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.tkkorea.photooptimizer"
        minSdk = 29          // MediaStore.setRequireOriginal (원본 위치 정보)
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    // 변환기는 브라우저판(photo_optimizer/docs)을 그대로 앱 안에 넣어 쓴다
    sourceSets["main"].assets.srcDir("../../photo_optimizer/docs")

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    androidResources {
        noCompress += listOf("wasm", "woff2")
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.webkit:webkit:1.18.0")
}
