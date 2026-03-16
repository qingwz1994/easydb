// drivers/mysql 模块：MySQL JDBC 适配器
plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":common"))
    implementation("com.mysql:mysql-connector-j:8.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
