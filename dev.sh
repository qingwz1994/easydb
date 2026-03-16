#!/bin/bash
#
# EasyDB 开发环境管理脚本
# 用法：./dev.sh [start|stop|restart|build|status|logs]
#

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
KERNEL_DIR="$PROJECT_DIR/kernel"
UI_DIR="$PROJECT_DIR/apps/desktop-ui"
KERNEL_JAR="$KERNEL_DIR/launcher/build/libs/launcher-1.0.0-SNAPSHOT-all.jar"
KERNEL_PORT=18080
KERNEL_PID_FILE="$PROJECT_DIR/.kernel.pid"
UI_PID_FILE="$PROJECT_DIR/.ui.pid"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[EasyDB]${NC} $1"; }
warn() { echo -e "${YELLOW}[EasyDB]${NC} $1"; }
err()  { echo -e "${RED}[EasyDB]${NC} $1"; }

# ─── 构建内核 ────────────────────────────────────────────
do_build() {
    log "🔨 构建内核..."
    cd "$KERNEL_DIR" && ./gradlew clean shadowJar
    if [ $? -eq 0 ]; then
        log "✅ 构建成功"
    else
        err "❌ 构建失败"
        exit 1
    fi
}

# ─── 启动内核 ────────────────────────────────────────────
start_kernel() {
    # 检查是否已在运行
    if lsof -i :$KERNEL_PORT -t > /dev/null 2>&1; then
        warn "内核已在运行 (port $KERNEL_PORT)"
        return
    fi

    if [ ! -f "$KERNEL_JAR" ]; then
        warn "JAR 不存在，先执行构建..."
        do_build
    fi

    log "🚀 启动内核 (port $KERNEL_PORT)..."
    cd "$KERNEL_DIR" && nohup java -jar "$KERNEL_JAR" > "$PROJECT_DIR/.kernel.log" 2>&1 &
    echo $! > "$KERNEL_PID_FILE"
    sleep 2

    if lsof -i :$KERNEL_PORT -t > /dev/null 2>&1; then
        log "✅ 内核已启动 (PID: $(cat $KERNEL_PID_FILE))"
    else
        err "❌ 内核启动失败，查看日志：cat $PROJECT_DIR/.kernel.log"
    fi
}

# ─── 启动前端 ────────────────────────────────────────────
start_ui() {
    if [ -f "$UI_PID_FILE" ] && kill -0 $(cat "$UI_PID_FILE") 2>/dev/null; then
        warn "前端已在运行 (PID: $(cat $UI_PID_FILE))"
        return
    fi

    log "🌐 启动前端..."
    cd "$UI_DIR" && nohup npm run dev > "$PROJECT_DIR/.ui.log" 2>&1 &
    echo $! > "$UI_PID_FILE"
    sleep 3
    log "✅ 前端已启动 → http://localhost:5173"
}

# ─── 停止内核 ────────────────────────────────────────────
stop_kernel() {
    log "🛑 停止内核..."
    # 通过端口杀
    local pids=$(lsof -i :$KERNEL_PORT -t 2>/dev/null)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null
        log "✅ 内核已停止"
    else
        log "内核未在运行"
    fi
    rm -f "$KERNEL_PID_FILE"
}

# ─── 停止前端 ────────────────────────────────────────────
stop_ui() {
    log "🛑 停止前端..."
    if [ -f "$UI_PID_FILE" ]; then
        local pid=$(cat "$UI_PID_FILE")
        # 杀主进程及子进程
        pkill -P $pid 2>/dev/null
        kill $pid 2>/dev/null
        rm -f "$UI_PID_FILE"
        log "✅ 前端已停止"
    else
        # 尝试通过端口杀
        local pids=$(lsof -i :5173 -t 2>/dev/null)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null
            log "✅ 前端已停止"
        else
            log "前端未在运行"
        fi
    fi
}

# ─── 状态 ────────────────────────────────────────────────
do_status() {
    echo ""
    # 内核状态
    if lsof -i :$KERNEL_PORT -t > /dev/null 2>&1; then
        log "内核：${GREEN}运行中${NC} (port $KERNEL_PORT, PID: $(lsof -i :$KERNEL_PORT -t | head -1))"
    else
        log "内核：${RED}已停止${NC}"
    fi

    # 前端状态
    if lsof -i :5173 -t > /dev/null 2>&1; then
        log "前端：${GREEN}运行中${NC} → http://localhost:5173"
    else
        log "前端：${RED}已停止${NC}"
    fi
    echo ""
}

# ─── 日志 ────────────────────────────────────────────────
do_logs() {
    local target=${2:-kernel}
    if [ "$target" = "kernel" ]; then
        tail -f "$PROJECT_DIR/.kernel.log"
    elif [ "$target" = "ui" ]; then
        tail -f "$PROJECT_DIR/.ui.log"
    else
        err "用法：./dev.sh logs [kernel|ui]"
    fi
}

# ─── 主入口 ──────────────────────────────────────────────
case "${1:-help}" in
    start)
        start_kernel
        start_ui
        do_status
        ;;
    stop)
        stop_ui
        stop_kernel
        ;;
    restart)
        stop_ui
        stop_kernel
        sleep 1
        start_kernel
        start_ui
        do_status
        ;;
    build)
        do_build
        ;;
    rebuild)
        stop_ui
        stop_kernel
        do_build
        start_kernel
        start_ui
        do_status
        ;;
    status)
        do_status
        ;;
    logs)
        do_logs "$@"
        ;;
    kernel)
        case "${2:-start}" in
            start)   start_kernel ;;
            stop)    stop_kernel ;;
            restart) stop_kernel; sleep 1; start_kernel ;;
        esac
        ;;
    ui)
        case "${2:-start}" in
            start) start_ui ;;
            stop)  stop_ui ;;
            restart) stop_ui; sleep 1; start_ui ;;
        esac
        ;;
    *)
        echo ""
        echo "  EasyDB 开发环境管理"
        echo ""
        echo "  用法：./dev.sh <命令>"
        echo ""
        echo "  命令："
        echo "    start      启动内核 + 前端"
        echo "    stop       停止全部"
        echo "    restart    重启全部"
        echo "    build      仅构建内核 (clean shadowJar)"
        echo "    rebuild    构建 + 重启全部"
        echo "    status     查看运行状态"
        echo "    logs       查看日志 (默认 kernel，可选 ui)"
        echo ""
        echo "    kernel start|stop|restart   单独管理内核"
        echo "    ui start|stop|restart       单独管理前端"
        echo ""
        ;;
esac
