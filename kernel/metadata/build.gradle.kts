// metadata 模块：元数据采集服务
plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":common"))
    implementation(project(":drivers:mysql"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
