// drivers/mysql 模块：MySQL JDBC 适配器
plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":common"))
    implementation("com.mysql:mysql-connector-j:8.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    testImplementation(kotlin("test"))
    testImplementation("io.mockk:mockk:1.13.10")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
