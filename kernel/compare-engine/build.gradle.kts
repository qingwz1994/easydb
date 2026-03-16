// compare-engine 模块：结构比对引擎（V2.0 预留）
plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":common"))
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
