// dialect 模块：SQL 方言与类型映射
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
