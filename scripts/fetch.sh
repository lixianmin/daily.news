#!/bin/bash
# fetch.sh — 抓取四个热点来源，保存到 <dataDir>/runs/<日期>/ 下（纯抓取，不调用 LLM）
# 数据目录来自环境变量 DAILY_NEWS_DATA_DIR（服务调用时注入），默认 ~/Documents/daily-news
# 用法:
#   ./fetch.sh           抓取全部来源
#   ./fetch.sh --sources gh,hn,zhihu,twitter  只抓指定来源
#   ./fetch.sh --date 2025-01-01  指定日期目录（默认今天）
set -o pipefail

DATA_DIR="${DAILY_NEWS_DATA_DIR:-$HOME/Documents/daily-news}"
DATE="$(date +%F)"
SOURCES="gh,hn,zhihu,twitter"
UA_MOBILE="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
LOG="$DATA_DIR/logs/fetch.log"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) ;; # 本身只抓数据，这一模式天然成立
    --data-dir) DATA_DIR="$2"; LOG="$DATA_DIR/logs/fetch.log"; shift ;;
    --sources) SOURCES="$2"; shift ;;
    --date) DATE="$2"; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

RUN_DIR="$DATA_DIR/runs/$DATE"
mkdir -p "$RUN_DIR" "$DATA_DIR/logs"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

ok()   { printf 'OK   %s\n' "$1" | tee -a "$LOG"; }
fail() { printf 'FAIL %s  %s\n' "$1" "$2" | tee -a "$LOG"; }

# ---------- GitHub Trending ----------
fetch_gh() {
  local tmp
  tmp="$RUN_DIR/.gh.html"
  if ! curl -sSL -m 40 "https://github.com/trending?since=daily" -H "User-Agent: $UA_MOBILE" -H "Accept: text/html" -o "$tmp"; then
    fail gh "curl 抓取失败"; return 1
  fi
  python3 - "$tmp" > "$RUN_DIR/gh.md" <<'PYEOF'
import sys, re, html
s = open(sys.argv[1], encoding='utf-8').read()
rows = re.findall(r'<article[^>]*class="Box-row"[^>]*>(.*?)</article>', s, re.S)
out = []
for r in rows[:20]:
    # 仓库名：h2.lh-condensed 里的链接才是真正的 repo 路径
    m = re.search(r'<h2 class="h3 lh-condensed">.*?href="/([^"]+)"', r, re.S)
    if not m: continue
    repo = m.group(1).strip()
    if not repo: continue
    d = re.search(r'<p class="col-9[^"]*"[^>]*>(.*?)</p>', r, re.S)
    desc = re.sub(r'<[^>]+>', '', d.group(1)) if d else ''
    desc = html.unescape(desc).strip()
    # 总 star：stargazers 链接的 svg 后的数字
    st = re.search(r'href="[^"]+/stargazers"[^>]*>.*?</svg>\s*([\d,]+)</a>', r, re.S)
    stars = st.group(1) if st else ''
    lg = re.search(r'itemprop="programmingLanguage">([^<]+)<', r)
    lang = lg.group(1) if lg else ''
    td = re.search(r'([\d,]+)\s+stars today', r)
    today = td.group(1) if td else ''
    parts = []
    if stars: parts.append(f"⭐{stars}")
    if lang:  parts.append(lang)
    if today: parts.append(f"⬆️+{today} today")
    meta = ("（" + " · ".join(parts) + "）") if parts else ""
    out.append(f"- **{repo}** — {desc}{meta}  |  https://github.com/{repo}")
print("## GitHub Trending（今日趨勢）\n")
print("\n".join(out) if out else "⚠️ 抓取失敗：頁面結構變化，未能解析到條目")
PYEOF
  local n; n="$(grep -c '^- ' "$RUN_DIR/gh.md" || true)"
  if [ "$n" -eq 0 ]; then fail gh "解析到 0 条"; return 1; fi
  ok "gh $n 条"
}

# ---------- Hacker News ----------
fetch_hn() {
  local json
  if ! json="$(curl -sSL -m 30 "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=25" -H "User-Agent: $UA_MOBILE")"; then
    fail hn "curl 抓取失败"; return 1
  fi
  echo "$json" | jq -r '.hits[] |
    [.title,
     ((.url // "") | gsub("\n"; " ")),
     (.points // 0),
     (.num_comments // 0),
     .objectID,
     .author] | @tsv' | head -20 > "$RUN_DIR/.hn.tsv"
  python3 - "$RUN_DIR/.hn.tsv" > "$RUN_DIR/hn.md" <<'PYEOF'
import sys
lines = [l.rstrip("\n") for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
out=[]
for t in lines:
    title, url, points, comments, oid, author = t.split("\t", 5)
    if not title or title == "null": continue
    link = url if url and url != "null" else "https://news.ycombinator.com/item?id=" + oid
    disc = "https://news.ycombinator.com/item?id=" + oid
    out.append(f"- **{title}** — ({points}★ · {comments}則評論)  |  原文: {link}  |  討論: {disc}")
print("## Hacker News（過去24小時熱點）\n")
print("\n".join(out) if out else "⚠️ 抓取失敗：無數據")
PYEOF
  local n; n="$(grep -c '^- ' "$RUN_DIR/hn.md" || true)"
  if [ "$n" -eq 0 ]; then fail hn "解析到 0 条"; return 1; fi
  ok "hn $n 条"
}

# ---------- 知乎热榜（newsnow.busiyi.world 聚合接口，纯 curl，无需登录/浏览器） ----------
fetch_zhihu() {
  local json
  if ! json="$(curl -sSL -m 30 -X POST "https://newsnow.busiyi.world/api/s/entire" \
      -H "Content-Type: application/json" \
      -H "User-Agent: $UA_MOBILE" \
      -H "Origin: https://newsnow.busiyi.world" \
      -H "Referer: https://newsnow.busiyi.world/" \
      -d '{"sources":["zhihu"]}')"; then
    fail zhihu "newsnow curl 抓取失败"; return 1
  fi
  printf '%s' "$json" > "$RUN_DIR/.zhihu.raw"
  python3 - "$RUN_DIR/.zhihu.raw" > "$RUN_DIR/zhihu.md" <<'PYEOF'
import sys, json, re
raw = open(sys.argv[1], encoding='utf-8').read()
d = json.loads(raw)
groups = d if isinstance(d, list) else d.get('data', [])
items = []
for g in groups:
    if g.get('id') == 'zhihu':
        items = g.get('items', []); break
out = []
for it in items[:20]:
    t = (it.get('title') or '').strip()
    if not t: continue
    qid = it.get('id')
    url = f"https://www.zhihu.com/question/{qid}" if qid else ''
    extra = it.get('extra') or {}
    info = (extra.get('info') or '').strip()
    hover = re.sub(r'\s+', ' ', (extra.get('hover') or '')).strip()
    if len(hover) > 180: hover = hover[:180] + '…'
    meta = f"（{info}）" if info else ""
    tail = f"  — {hover}" if hover and hover != t else ""
    out.append(f"- **{t}**{tail}{meta}  |  {url}")
print("## 知乎熱榜（24小時）\n")
print("\n".join(out) if out else "⚠️ 抓取失敗：無數據")
PYEOF
  local n; n="$(grep -c '^- ' "$RUN_DIR/zhihu.md" || true)"
  if [ "$n" -eq 0 ]; then fail zhihu "解析到 0 条"; return 1; fi
  ok "zhihu $n 条"
}

# ---------- Twitter / X 时间线（dokobot 浏览器登录态） ----------
fetch_twitter() {
  if ! dokobot read --local --screens 6 --timeout 120 "https://x.com/home" > "$RUN_DIR/twitter_raw.txt" 2>"$RUN_DIR/.twitter.err"; then
    fail twitter "dokobot 抓取失败: $(head -c 200 "$RUN_DIR/.twitter.err")"; return 1
  fi
  # 真实性校验：占位页/登录墙时行数少且无 @handle，判失败重试
  local n h
  n="$(wc -l < "$RUN_DIR/twitter_raw.txt")"
  h="$(grep -cE '@[A-Za-z0-9_]{2,}' "$RUN_DIR/twitter_raw.txt" || true)"
  if [ "$n" -lt 30 ] || [ "$h" -lt 5 ]; then
    fail twitter "未渲染出推文（占位页/登录墙：$n 行，$h 个 @）"; return 1
  fi
  ok "twitter 原始文本 $n 行"
}

# ---------- 汇总元信息 ----------
meta() {
  cat > "$RUN_DIR/meta.txt" <<EOF
抓取时间: $(date '+%F %T')
来源: GitHub Trending / Hacker News / 知乎熱榜 / Twitter 時間線
状态:
$(for f in gh.md hn.md zhihu.md twitter_raw.txt; do [ -s "$RUN_DIR/$f" ] && echo "  $f: $(wc -c < "$RUN_DIR/$f") bytes" || echo "  $f: 缺失"; done)
EOF
}

run_source() {
  case "$1" in
    gh)      retry 2 4 fetch_gh ;;
    hn)      retry 2 4 fetch_hn ;;
    zhihu)   retry 3 8 fetch_zhihu ;;
    twitter) retry 4 12 fetch_twitter ;;
    *) echo "未知来源: $1" >&2 ;;
  esac
}

# 重试：retry <次数> <间隔秒> <命令...>
retry() {
  local n="$1" delay="$2" i=0
  shift 2
  while [ "$i" -lt "$n" ]; do
    i=$((i+1))
    if "$@"; then return 0; fi
    if [ "$i" -lt "$n" ]; then
      echo "  ↻ 重试 ($i/$n)… $1"; sleep "$delay"
    fi
  done
  return 1
}

log "==== 开始抓取 $DATE [$SOURCES] ===="
IFS=',' read -ra SRC <<< "$SOURCES"
for s in "${SRC[@]}"; do
  run_source "$s"
done
meta

total=0
for f in gh.md hn.md zhihu.md twitter_raw.txt; do [ -s "$RUN_DIR/$f" ] && total=$((total+1)); done
echo
echo "==== 汇总 ===="
echo "目录: $RUN_DIR"
echo "成功来源: $total/4"
for f in gh.md hn.md zhihu.md; do
  [ -s "$RUN_DIR/$f" ] && printf "  %-12s %s 条\n" "$f" "$(grep -c '^- ' "$RUN_DIR/$f")"
done
[ -s "$RUN_DIR/twitter_raw.txt" ] && printf "  %-12s %s 行原始文本\n" "twitter_raw.txt" "$(wc -l < "$RUN_DIR/twitter_raw.txt")"

# 保留策略：runs 保留 7 天，日志保留 30 天
find "$DATA_DIR/runs" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null || true
find "$DATA_DIR/logs" -type f -mtime +30 -delete 2>/dev/null || true
