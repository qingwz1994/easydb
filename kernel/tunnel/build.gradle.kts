// tunnel 模块：SSH 隧道 / SSL 支持
plugins {
    kotlin("jvm")
}

dependencies {
    implementation(project(":common"))
    implementation("com.github.mwiede:jsch:0.2.16")
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(21)
}
