import type {
  DigestDay,
  DigestIndex,
  DigestItem,
  DigestSection,
  IndexDay,
  SourceKey,
} from "./types.ts";
import { SOURCE_KEYS, SOURCE_SHORT, SOURCE_TITLES } from "./types.ts";
import { formatShanghai } from "./config.ts";
import { STYLES, TOKENS } from "./design.ts";

/** HTML 转义。内容是外部抓来的，一律当作不可信文本处理。 */
export function escapeHtml(text: string): string {
  const AMP = String.fromCharCode(38);
  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  const QUOT = String.fromCharCode(34);
  const APOS = String.fromCharCode(39);
  const ENT_AMP = AMP + "amp;";
  const ENT_LT = AMP + "lt;";
  const ENT_GT = AMP + "gt;";
  const ENT_QUOT = AMP + "quot;";
  const ENT_APOS = AMP + "#39;";
  return text
    .split(AMP).join(ENT_AMP)
    .split(LT).join(ENT_LT)
    .split(GT).join(ENT_GT)
    .split(QUOT).join(ENT_QUOT)
    .split(APOS).join(ENT_APOS);
}

/** 只放行 http(s)，挡住 javascript: 之类的脏链接。 */
function safeUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : undefined;
}

interface LayoutOptions {
  title: string;
  body: string;
  /** 额外 head 片段。 */
  head?: string;
  /** 侧边栏 HTML。 */
  sidebar: string;
  /** 浮动目录面板的内容。 */
  toc: string;
}

function layout(options: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${TOKENS}${STYLES}</style>
${options.head ?? ""}
</head>
<body>
<div class="shell">
  <aside class="sidebar" id="sidebar">${options.sidebar}</aside>
  <div class="main"><div class="wrap" id="top">${options.body}</div></div>
</div>
<div class="toc-dock" id="tocDock">
  <div class="toc-float" id="tocFloat" hidden>
    <div class="toc-head" id="tocHead">
      <span class="toc-title">目录</span>
      <span class="toc-hint">拖动可移动</span>
      <button class="toc-close" id="tocClose" type="button" aria-label="关闭">✕</button>
    </div>
    <div class="toc-body" id="tocBody">${options.toc}</div>
  </div>
  <button class="toc-fab" id="tocFab" type="button" aria-label="目录" aria-expanded="false" aria-controls="tocFloat">☰</button>
</div>
</body>
</html>`;
}

/**
 * 浮动目录面板的内容。
 *
 * 与侧边栏同源（搜索 + Today 章节 + History），但可以拖动、位置记在
 * localStorage 里。滚动到中间时不用往回滚就能跳转。
 */
interface TocOptions {
  /** 历史日期（倒序）。 */
  days: IndexDay[];
  /** 当前日期。 */
  current?: string;
  /** 本日章节（key + 条数）。 */
  sections?: Array<{ key: SourceKey; count: number }>;
  /** 是否有搜索框。 */
  search?: boolean;
}

function renderToc(options: TocOptions): string {
  const history = options.days
    .map((day) => {
      const active = day.date === options.current;
      return `<a class="toc-link${active ? " active" : ""}" href="/d/${escapeHtml(day.date)}">
      <span>${escapeHtml(day.date)}</span>
      <span class="count">${day.total}</span>
    </a>`;
    })
    .join("");

  const sections =
    options.sections === undefined
      ? ""
      : options.sections
          .map(
            (section) => `<a class="toc-link" href="#sec-${escapeHtml(section.key)}" data-spy="${escapeHtml(section.key)}">
      <span>${escapeHtml(SOURCE_SHORT[section.key])}</span>
      <span class="count">${section.count}</span>
    </a>`,
          )
          .join("");

  return `${options.search === false ? "" : `<div class="toc-search"><input type="search" data-search placeholder="搜索所有日期…" autocomplete="off"></div>`}
${sections === "" ? "" : `<div class="toc-group">
  <div class="toc-label">Today</div>
  ${sections}
</div>`}
<div class="toc-group">
  <div class="toc-label">History</div>
  ${history === "" ? '<div class="toc-link" style="color:var(--faint)">暂无</div>' : history}
</div>
<a class="toc-link toc-top-link" href="#top">↑ 回到顶部</a>`;
}

/** 侧边栏：品牌 + 搜索 + 历史日期 + 本日章节。 */
interface SidebarOptions {
  /** 历史日期（倒序）。 */
  days: IndexDay[];
  /** 当前日期。 */
  current?: string;
  /** 本日章节（key + 条数）。 */
  sections?: Array<{ key: SourceKey; count: number }>;
  /** 是否有搜索框（首页有，详情页也有）。 */
  search?: boolean;
  /** 额外的底部内容（如重新生成按钮）。 */
  footer?: string;
}

function renderSidebar(options: SidebarOptions): string {
  const history = options.days
    .map((day) => {
      const active = day.date === options.current;
      return `<a class="side-link${active ? " active" : ""}" href="/d/${escapeHtml(day.date)}">
      ${active ? '<span class="dot"></span>' : ""}
      <span class="date">${escapeHtml(day.date)}</span>
      <span class="count">${day.total}</span>
    </a>`;
    })
    .join("\n    ");

  const sections =
    options.sections === undefined
      ? ""
      : `<div class="side-group">
    <div class="side-label">Today</div>
    ${options.sections
      .map(
        (section) => `<a class="side-link" href="#sec-${escapeHtml(section.key)}" data-spy="${escapeHtml(section.key)}">
      <span>${escapeHtml(SOURCE_SHORT[section.key])}</span>
      <span class="count">${section.count}</span>
    </a>`,
      )
      .join("\n    ")}
  </div>`;

  return `<div class="side-top">
  <a class="brand" href="/" title="回到主页">
    <h1>Daily Digest</h1>
    <div class="sub">每日热点摘要</div>
  </a>
  ${options.search === false ? "" : `<div class="side-search"><input type="search" data-search placeholder="搜索所有日期…" autocomplete="off"></div>`}
</div>
<div class="side-bottom">
<div class="side-group">
  <div class="side-label">History</div>
  ${history === "" ? '<div class="side-link" style="color:var(--faint)">暂无</div>' : history}
</div>
${sections}
${options.footer ?? ""}
</div>`;
}

/** 章节锚点 id。 */
function sectionId(key: SourceKey): string {
  return `sec-${key}`;
}

/** 来源标签的显示名与 CSS class。 */
const SOURCE_TAG: Record<SourceKey, { label: string; cls: string }> = {
  twitter: { label: "Twitter", cls: "src-twitter" },
  github: { label: "GitHub", cls: "src-github" },
  hackernews: { label: "Hacker News", cls: "src-hackernews" },
  zhihu: { label: "知乎", cls: "src-zhihu" },
};

/** 来源标签。每张卡片都标，扫的时候知道这条从哪来。 */
function renderSourceTag(key: SourceKey): string {
  const tag = SOURCE_TAG[key];
  return `<span class="src ${tag.cls}">${escapeHtml(tag.label)}</span>`;
}

/** 元信息 chip。 */
function renderChips(item: DigestItem): string {
  const meta = item.meta;
  if (meta === undefined) {
    return "";
  }
  const chips: string[] = [];

  if (meta.source === "github") {
    const { stars, language, todayStars } = meta.github;
    if (stars !== undefined) {
      chips.push(`<span class="chip star">★ ${escapeHtml(stars)}</span>`);
    }
    if (todayStars !== undefined) {
      chips.push(`<span class="chip up">+${escapeHtml(todayStars)} today</span>`);
    }
    if (language !== undefined) {
      chips.push(`<span class="chip lang">${escapeHtml(language)}</span>`);
    }
  }
  if (meta.source === "hackernews") {
    const { points, comments } = meta.hn;
    if (points !== undefined) {
      chips.push(`<span class="chip up">${points} points</span>`);
    }
    if (comments !== undefined) {
      chips.push(`<span class="chip">${comments} comments</span>`);
    }
  }

  return chips.length === 0 ? "" : `<div class="chips">${chips.join("")}</div>`;
}

/** 「原文 ↗」按钮。 */
function renderOriginalLink(url: string | undefined, label = "原文"): string {
  const safe = safeUrl(url);
  if (safe === undefined) {
    return "";
  }
  return `<a class="link-btn" href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} <span class="ext">↗</span></a>`;
}

/**
 * 一条正文的中英对照：左英右繁。
 *
 * 两列内容一致——英文是原文，繁中是同一句的翻译。
 * 翻译拿不到时右列留空（CSS 里 `:empty` 隐藏），左列不受影响。
 *
 * `en` 传进来的必须是**已转义好的 HTML**（Twitter 的要点里含 handle 链接，
 * 不能再转一次）；`zh` 是纯文本，这里负责转义。
 */
function renderDuo(enHtml: string, zh: string, cls: string): string {
  return `<div class="duo">
  <div class="${cls} en">${enHtml}</div>
  <div class="${cls} zh">${escapeHtml(zh)}</div>
</div>`;
}

/** 一张条目卡片。 */
function renderItemCard(item: DigestItem, source: SourceKey): string {
  const url = safeUrl(item.url);
  const title =
    url === undefined
      ? escapeHtml(item.title)
      : `<a class="card-title" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`;

  const extra = (item.extraLinks ?? [])
    .map((link) => {
      const safe = safeUrl(link.url);
      if (safe === undefined) {
        return "";
      }
      return `<a class="link-btn quiet" href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} ↗</a>`;
    })
    .join("");

  // 摘要默认夹三行，点「More」展开
  const needsExpand = item.en.length > 150;

  return `<article class="card">
  <div class="card-top">
    ${renderSourceTag(source)}
    <div class="card-title">${title}</div>
  </div>
  ${renderChips(item)}
  <div class="card-sum${needsExpand ? " clamp" : ""}" data-full="${escapeHtml(item.en)}">${renderDuo(escapeHtml(item.en), item.zh, "sum")}</div>
  <div class="card-foot">
    ${renderOriginalLink(item.url)}
    ${extra}
    <span class="spacer"></span>
    ${needsExpand ? '<button class="expand-btn" type="button">More ▾</button>' : ""}
  </div>
</article>`;
}

/** Twitter 分类块。 */
function renderCategory(category: {
  title: string;
  titleZh: string;
  items: Array<{ en: string; zh: string; url?: string }>;
}): string {
  const items = category.items
    .map((item) => {
      const url = safeUrl(item.url);
      // 要点正文里带 @handle，把 handle 变成链接。
      // 顺序要紧：先逐段转义并替换 handle，最后才拼 HTML——
      // 先整体转义再插标签的话，标签本身会被转义掉。
      const text = escapeHtml(item.en)
        .split(/(@[A-Za-z0-9_]{1,15})/g)
        .map((part) => {
          if (!part.startsWith("@")) {
            return part;
          }
          if (url === undefined) {
            return part;
          }
          return `<a class="cite" href="${url}" target="_blank" rel="noopener noreferrer">${part}</a>`;
        })
        .join("");
      // 每条要点都标来源——Twitter 用的是分类列表，不走 renderItemCard，
      // 不标的话就跟 GitHub/HN/知乎 的卡片不一致，扫的时候不知道这条从哪来
      return `<li>
      <div class="pt-top">${renderSourceTag("twitter")}</div>
      ${renderDuo(text, item.zh, "pt")}
    </li>`;
    })
    .join("\n");

  const titleZh =
    category.titleZh === "" ? "" : ` <span class="tz">${escapeHtml(category.titleZh)}</span>`;

  return `<div class="cat">
  <div class="cat-title">${escapeHtml(category.title)}${titleZh} <span class="n">${category.items.length}</span></div>
  <ul class="cat-items">
    ${items}
  </ul>
</div>`;
}

/** 一个章节。 */
function renderSection(section: DigestSection): string {
  const count =
    section.kind === "items"
      ? section.items.length
      : section.categories.reduce((sum, category) => sum + category.items.length, 0);

  const body =
    section.kind === "items"
      ? section.items.map((item) => renderItemCard(item, section.key)).join("\n")
      : section.categories.map((category) => renderCategory(category)).join("\n");

  return `<section class="section" id="${sectionId(section.key)}">
  <div class="section-head">
    <h3>${escapeHtml(section.title)}</h3>
    <span class="badge">${count}</span>
    <span class="rule"></span>
  </div>
  ${body}
</section>`;
}

/** 失败来源的提示块。 */
function renderMissing(sources: DigestDay["sources"]): string {
  const missing = SOURCE_KEYS.filter((key) => sources[key]?.ok !== true);
  if (missing.length === 0) {
    return "";
  }

  const names = missing.map((key) => SOURCE_SHORT[key]).join("、");
  return `<div class="warn-box">⚠️ <b>${escapeHtml(names)}</b> 本次未成功——可能是抓取失败或生成失败。</div>`;
}

/** 首页：日期列表。 */
export function renderIndexPage(index: DigestIndex, today?: string): string {
  const rows = index.days
    .map((day) => {
      const counts = SOURCE_KEYS.filter((key) => (day.counts[key] ?? 0) > 0)
        .map((key) => `<span class="chip">${escapeHtml(SOURCE_SHORT[key])} ${day.counts[key]}</span>`)
        .join("");

      const isToday = day.date === today;
      const heads = day.headlines.slice(0, 4).map(escapeHtml).join(" · ");

      return `<a class="day-row" href="/d/${escapeHtml(day.date)}">
  <span class="date">${escapeHtml(day.date)}</span>
  <span class="wd">${escapeHtml(day.weekday)}</span>
  ${isToday ? '<span class="today-tag">TODAY</span>' : ""}
  <span class="spacer"></span>
  <span class="counts">${counts}</span>
  <span class="tot">${day.total} items</span>
  ${heads === "" ? "" : `<span class="heads">${heads}</span>`}
</a>`;
    })
    .join("\n");

  const body =
    index.days.length === 0
      ? `<div class="empty">还没有任何数据。<br>点右上角「重新生成」跑一次，或等每天 07:00 的定时任务。</div>`
      : `<div class="page-head">
  <div>
    <h2>每日热点摘要</h2>
    <div class="meta">${index.days.length} 天 · 更新于 ${escapeHtml(formatShanghai(index.updatedAt))}</div>
  </div>
  <span class="spacer"></span>
  <button class="btn primary" id="regen" type="button">重新生成</button>
</div>
<div class="progress" id="progress"></div>
<div id="hits"></div>
<div class="day-list">
${rows}
</div>`;

  return layout({
    title: "每日热点摘要",
    head: `<script src="/app.js" defer></script>`,
    sidebar: renderSidebar({ days: index.days, current: today }),
    toc: renderToc({ days: index.days, current: today }),
    body,
  });
}

export interface Neighbors {
  newer?: string;
  older?: string;
}

/** 详情页：某一天。 */
export function renderDayPage(day: DigestDay, neighbors: Neighbors = {}, history: IndexDay[] = [], today?: string): string {
  const sections = day.sections.map((section) => renderSection(section)).join("\n");

  // 只有当天能重新生成：昨天的内容已经定稿，再生成一遍没有意义。
  const isToday = today !== undefined && day.date === today;

  const sideSections = day.sections.map((section) => ({
    key: section.key,
    count:
      section.kind === "items"
        ? section.items.length
        : section.categories.reduce((sum, category) => sum + category.items.length, 0),
  }));

  const newerLink =
    neighbors.newer === undefined
      ? "<span></span>"
      : `<a class="btn" href="/d/${escapeHtml(neighbors.newer)}">← ${escapeHtml(neighbors.newer)}</a>`;
  const olderLink =
    neighbors.older === undefined
      ? "<span></span>"
      : `<a class="btn" href="/d/${escapeHtml(neighbors.older)}">${escapeHtml(neighbors.older)} →</a>`;

  const body = `<div class="page-head">
  <div>
    <h2>${escapeHtml(day.date)}</h2>
    <div class="meta">${escapeHtml(day.weekday)} · ${day.sections.length} sections · ${escapeHtml(day.model)} · ${escapeHtml(formatShanghai(day.generatedAt))}</div>
  </div>
  <span class="spacer"></span>
  ${isToday ? '<button class="btn" id="regen" type="button">重新生成</button>' : ""}
</div>
<div class="progress" id="progress"></div>
${renderMissing(day.sources)}
${sections}
<nav class="pager">${newerLink}${olderLink}</nav>`;

  return layout({
    title: `${day.date} 每日热点摘要`,
    head: `<script src="/app.js" defer></script>`,
    sidebar: renderSidebar({
      days: history,
      current: day.date,
      sections: sideSections,
      footer: `<div class="side-group"><a class="side-link" href="/">← 所有日期</a></div>`,
    }),
    toc: renderToc({ days: history, current: day.date, sections: sideSections }),
    body,
  });
}

/** 搜索结果片段。 */
export interface SearchHitPayload {
  date: string;
  section: string;
  title: string;
  en: string;
  url?: string;
}

export function renderSearchHits(hits: SearchHitPayload[]): string {
  if (hits.length === 0) {
    return `<div class="empty">没有匹配的结果。</div>`;
  }
  return hits
    .map((hit) => {
      const url = safeUrl(hit.url);
      const title =
        url === undefined
          ? escapeHtml(hit.title)
          : `<a class="t" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(hit.title)}</a>`;
      return `<div class="hit">
  <div class="where">${escapeHtml(hit.date)} · ${escapeHtml(hit.section)}</div>
  <div class="t">${title}</div>
  <div class="s">${escapeHtml(hit.en)}</div>
</div>`;
    })
    .join("\n");
}

export { SOURCE_TITLES };
export type { SourceKey };
