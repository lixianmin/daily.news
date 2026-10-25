#!/bin/bash
# install.sh — 安装/卸载 daily.news 常驻服务 (launchd)
# 用法:
#   ./scripts/install.sh            安装并启动
#   ./scripts/install.sh --restart  只重启
#   ./scripts/install.sh --remove   卸载（保留数据与日志）
set -o pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.xmli.daily-news"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Documents/daily-news/logs"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "已卸载 $LABEL（数据在 ~/Documents/daily-news，未删除）"
  exit 0
fi

if [ "${1:-}" = "--restart" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
  echo "已重启 $LABEL"
  exit 0
fi

# Bun 的路径：launchd 不读 shell rc，必须写死绝对路径
BUN_BIN="$(command -v bun)"
if [ -z "$BUN_BIN" ]; then
  echo "❌ 找不到 bun，先安装：https://bun.sh"
  exit 1
fi

if [ ! -f "$DIR/.env" ]; then
  echo "⚠️  缺少 .env，调试面板（/shell）不会挂载。先执行：cp .env.example .env 并填值"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Description</key>
	<string>每日热点摘要 Web 服务，端口 5003</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>HOME</key>
		<string>$HOME</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN_BIN</string>
		<string>run</string>
		<string>$DIR/src/main.ts</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/server.err.log</string>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/server.out.log</string>
	<key>WorkingDirectory</key>
	<string>$DIR</string>
</dict>
</plist>
PLIST

if ! plutil -lint "$PLIST_DST" >/dev/null; then
  echo "❌ plist 语法错误: $PLIST_DST"
  exit 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "✅ 已安装 $LABEL"
sleep 2
if launchctl list | grep -q "$LABEL"; then
  PORT=$(lsof -nP -iTCP:5003 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | head -1)
  if [ -n "$PORT" ]; then
    echo "   ✅ 端口 5003 已监听 (pid $PORT)"
    echo "   本机:   http://127.0.0.1:5003"
    LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
    [ -n "$LAN" ] && echo "   局域网: http://$LAN:5003"
    echo "   调试面板: http://127.0.0.1:5003/shell"
  else
    echo "   ⚠️ 端口 5003 未监听，看日志: $LOG_DIR/server.err.log"
  fi
else
  echo "   ⚠️ 未在 launchctl 列表看到 $LABEL"
fi
