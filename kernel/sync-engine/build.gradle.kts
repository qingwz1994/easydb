// sync-engine 模块：数据同步引擎
plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":common"))
    implementation(project(":drivers:mysql"))
    implementation(project(":metadata"))
    implementation(project(":dialect"))
    implementation(project(":task-center"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
