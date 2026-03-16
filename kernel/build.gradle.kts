plugins {
    kotlin("jvm") version "1.9.22" apply false
    kotlin("plugin.serialization") version "1.9.22" apply false
    id("com.github.johnrengelman.shadow") version "8.1.1" apply false
}

allprojects {
    group = "com.easydb"
    version = "1.0.0-SNAPSHOT"

    repositories {
        mavenCentral()
    }
}
