import type { DigestDay, DigestIndex, DigestSection, SourceKey } from "./types.ts";
import { SOURCE_KEYS, SOURCE_TITLES } from "./types.ts";

/** HTML 转义。内容是外部抓来的，一律当作不可信文本处理。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只放行 http(s)，挡住 javascript: 之类的脏链接。 */
function safeUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined;
}

interface LayoutOptions {
  title: string;
  /** 页面主内容。 */
  body: string;
  /** 额外的 head 片段（首页要挂搜索脚本）。 */
  head?: string;
}

function layout(options: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLE}</style>
${options.head ?? ""}
</head>
<body>
${options.body}
</body>
</html>`;
}

const STYLE = `
:root{--bg:#fbfaf7;--fg:#1f2328;--muted:#6b7280;--line:#e5e2da;--accent:#b45309;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e6e6e6;--muted:#9aa0a6;--line:#2a2e36;--accent:#f0a35e;--card:#1d2027}}
*{box-sizing:border-box}
body{margin:0;padding:0 16px 64px;background:var(--bg);color:var(--fg);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:820px;margin:0 auto}
header.top{max-width:820px;margin:0 auto;padding:28px 0 8px;display:flex;flex-wrap:wrap;
  gap:12px;align-items:baseline;justify-content:space-between;border-bottom:1px solid var(--line)}
header.top h1{font-size:1.35rem;margin:0;letter-spacing:.02em}
header.top .tools{display:flex;gap:8px;align-items:center}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.muted{color:var(--muted);font-size:.85rem}
.day-list{list-style:none;padding:0;margin:20px 0}
.day-list li{border-bottom:1px solid var(--line)}
.day-list a{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;padding:14px 4px;color:var(--fg)}
.day-list .date{font-weight:600;font-variant-numeric:tabular-nums}
.day-list .total{color:var(--muted);font-size:.85rem}
.day-list .heads{color:var(--muted);font-size:.8rem;flex-basis:100%;margin-top:2px}
.warn{color:#b91c1c}
@media (prefers-color-scheme:dark){.warn{color:#f87171}}
h2{font-size:1.1rem;margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:1rem;margin:22px 0 8px;color:var(--accent)}
.item{margin:0 0 20px}
.item .title{font-weight:600}
.item .en{color:var(--fg)}
.item .zh{color:var(--muted);margin-top:2px}
ol.points{margin:8px 0 0;padding-left:1.4em}
ol.points li{margin-bottom:12px}
ol.points .zh{color:var(--muted);margin-top:2px}
input[type=search]{padding:7px 10px;border:1px solid var(--line);border-radius:6px;
  background:var(--card);color:var(--fg);min-width:220px;font-size:.9rem}
button{padding:7px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);
  color:var(--fg);font-size:.9rem;cursor:pointer}
button:hover{border-color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
nav.pager{display:flex;justify-content:space-between;gap:12px;margin:28px 0 0;
  padding-top:16px;border-top:1px solid var(--line);font-size:.9rem}
#progress{font-size:.85rem;color:var(--muted);min-height:1.3em;margin-top:8px}
#hits{margin-top:16px}
.hit{border-bottom:1px solid var(--line);padding:12px 0}
.hit .where{color:var(--muted);font-size:.8rem}
`;

/** 来源完整度：`4/4` 或 `2/4`，不足时加警示样式。 */
function sourcesBadge(sourcesOk: number): string {
  const total = SOURCE_KEYS.length;
  const cls = sourcesOk === total ? "muted" : "warn";
  return `<span class="${cls}">${sourcesOk}/${total} 源</span>`;
}

export function renderIndexPage(index: DigestIndex): string {
  const items = index.days
    .map((day) => {
      const heads = day.headlines.slice(0, 3).map(escapeHtml).join(" · ");
      return `      <li>
        <a href="/d/${escapeHtml(day.date)}">
          <span class="date">${escapeHtml(day.date)}</span>
          <span class="muted">${escapeHtml(day.weekday)}</span>
          ${sourcesBadge(day.sourcesOk)}
          <span class="total">${day.total} 条</span>
          ${heads === "" ? "" : `<span class="heads">${heads}</span>`}
        </a>
      </li>`;
    })
    .join("\n");

  const body =
    index.days.length === 0
      ? `<main><p class="muted">暂无数据。点上方「重新生成」跑一次，或等每天 07:00 的定时任务。</p></main>`
      : `<main><ul class="day-list">\n${items}\n</ul></main>`;

  return layout({
    title: "每日热点摘要",
    head: `<script src="/app.js" defer></script>`,
    body: `<header class="top">
  <h1>每日热点摘要</h1>
  <div class="tools">
    <input id="q" type="search" placeholder="搜索所有日期…" autocomplete="off">
    <button id="regen" type="button">重新生成</button>
  </div>
</header>
<div id="progress"></div>
<div id="hits"></div>
${body}`,
  });
}

/** 章节里的条目数。 */
function countSection(section: DigestSection): number {
  return section.kind === "items"
    ? section.items.length
    : section.categories.reduce((sum, category) => sum + category.items.length, 0);
}

/** 失败/缺失来源的告警块。 */
function renderMissing(sources: DigestDay["sources"]): string {
  const missing = SOURCE_KEYS.filter((key) => sources[key]?.ok !== true);
  if (missing.length === 0) return "";

  const lines = missing
    .map((key) => {
      const reason = sources[key]?.error ?? "未抓取";
      return `<li>${escapeHtml(SOURCE_TITLES[key])} — ${escapeHtml(reason)}</li>`;
    })
    .join("");
  return `<p class="warn">⚠️ 以下来源本次未成功：</p><ul class="warn">${lines}</ul>`;
}

function renderItems(section: Extract<DigestSection, { kind: "items" }>): string {
  return section.items
    .map((item) => {
      const url = safeUrl(item.url);
      const title = url === undefined ? escapeHtml(item.title) : `<a href="${url}">${escapeHtml(item.title)}</a>`;
      const zh = item.zh === "" ? "" : `\n  <div class="zh">${escapeHtml(item.zh)}</div>`;
      return `<div class="item">
  <div class="title">${title}</div>
  <div class="en">${escapeHtml(item.en)}</div>${zh}
</div>`;
    })
    .join("\n");
}

function renderCategories(section: Extract<DigestSection, { kind: "categories" }>): string {
  return section.categories
    .map((category) => {
      const zhTitle = category.titleZh === "" ? "" : ` <span class="muted">${escapeHtml(category.titleZh)}</span>`;
      const points = category.items
        .map((item) => {
          const zh = item.zh === "" ? "" : `\n    <div class="zh">${escapeHtml(item.zh)}</div>`;
          return `  <li>${escapeHtml(item.en)}${zh}</li>`;
        })
        .join("\n");
      return `<h3>${escapeHtml(category.title)}${zhTitle}</h3>
<ol class="points">
${points}
</ol>`;
    })
    .join("\n");
}

export interface Neighbors {
  newer?: string;
  older?: string;
}

export function renderDayPage(day: DigestDay, neighbors: Neighbors = {}): string {
  const sections = day.sections
    .map((section) => {
      const inner = section.kind === "items" ? renderItems(section) : renderCategories(section);
      return `<h2>${escapeHtml(section.title)} <span class="muted">${countSection(section)} 条</span></h2>
${inner}`;
    })
    .join("\n");

  const newerLink =
    neighbors.newer === undefined
      ? "<span></span>"
      : `<a href="/d/${escapeHtml(neighbors.newer)}">← ${escapeHtml(neighbors.newer)}</a>`;
  const olderLink =
    neighbors.older === undefined
      ? "<span></span>"
      : `<a href="/d/${escapeHtml(neighbors.older)}">${escapeHtml(neighbors.older)} →</a>`;

  return layout({
    title: `${day.date} 每日热点摘要`,
    body: `<header class="top">
  <h1>${escapeHtml(day.date)} <span class="muted">${escapeHtml(day.weekday)}</span></h1>
  <div class="tools"><a href="/">← 返回列表</a></div>
</header>
<main>
<p class="muted">模型 ${escapeHtml(day.model)} · 生成于 ${escapeHtml(day.generatedAt)}</p>
${renderMissing(day.sources)}
${sections}
<nav class="pager">${newerLink}${olderLink}</nav>
</main>`,
  });
}

/** 搜索结果片段（首页用，客户端渲染）。 */
export interface SearchHitPayload {
  date: string;
  section: string;
  title: string;
  en: string;
  zh: string;
  url?: string;
}

export function renderSearchHits(hits: SearchHitPayload[]): string {
  if (hits.length === 0) return `<p class="muted">没有匹配的结果。</p>`;
  return hits
    .map((hit) => {
      const url = safeUrl(hit.url);
      const title = url === undefined ? escapeHtml(hit.title) : `<a href="${url}">${escapeHtml(hit.title)}</a>`;
      const zh = hit.zh === "" ? "" : `<div class="zh">${escapeHtml(hit.zh)}</div>`;
      return `<div class="hit">
  <div class="where">${escapeHtml(hit.date)} · ${escapeHtml(hit.section)}</div>
  <div class="title">${title}</div>
  <div class="en">${escapeHtml(hit.en)}</div>${zh}
</div>`;
    })
    .join("\n");
}

export type { SourceKey };
