rootProject.name = "easydb-kernel"

include(
    "common",
    "api",
    "drivers:mysql",
    "metadata",
    "dialect",
    "compare-engine",
    "sync-engine",
    "migration-engine",
    "tunnel",
    "task-center",
    "launcher"
)
