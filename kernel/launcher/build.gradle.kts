plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    id("com.github.johnrengelman.shadow") version "8.1.1"
    application
}

dependencies {
    implementation(project(":common"))
    implementation(project(":api"))
    implementation(project(":drivers:mysql"))
    implementation(project(":metadata"))
    implementation(project(":dialect"))
    implementation(project(":sync-engine"))
    implementation(project(":migration-engine"))
    implementation(project(":task-center"))
    implementation(project(":tunnel"))
    implementation(project(":backup-engine"))

    // Ktor HTTP server
    val ktorVersion = "2.3.7"
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-netty:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("io.ktor:ktor-server-cors:$ktorVersion")
    implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
    implementation("io.ktor:ktor-server-call-logging:$ktorVersion")

    // MySQL Binlog CDC
    implementation("com.zendesk:mysql-binlog-connector-java:0.30.3")

    // Logging
    implementation("ch.qos.logback:logback-classic:1.4.14")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    testImplementation(kotlin("test"))
}

application {
    mainClass.set("com.easydb.launcher.MainKt")
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
