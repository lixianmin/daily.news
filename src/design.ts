/**
 * 设计规范：排版的唯一真相源。
 *
 * 三个目标，按优先级：
 *   1. 一眼扫完 → 决定要不要点进去（标题 + 元信息足够判断，摘要收着）
 *   2. 链接可见 → 原始链接是显式按钮，不跟正文混在一起
 *   3. 有导航   → 左侧常驻栏，历史日期 + 本日章节
 *
 * 视觉基调：暖中性纸感 + 一个克制的强调色。信息密度高但不拥挤——
 * 靠留白与层级分隔，不靠颜色堆砌。
 */

/** 设计令牌。改这里就改了全局视觉。 */
export const TOKENS = `
:root{
  /* 底色与层 */
  --bg:#f7f5f1;
  --surface:#ffffff;
  --surface-2:#fbfaf8;
  --sidebar:#f1eee8;
  /* 文字 */
  --fg:#1c1a17;
  --fg-2:#4a453e;
  --muted:#8b8378;
  --faint:#b3aa9d;
  /* 线 */
  --line:#e5e0d7;
  --line-2:#efeae1;
  /* 强调：只用在「可点」「当前」上 */
  --accent:#b45309;
  --accent-soft:#fdf0e2;
  --accent-line:#f0d9bd;
  /* 语义 */
  --star:#c2820b;
  --up:#15803d;
  --up-soft:#e8f5ec;
  /* 尺寸 */
  --sidebar-w:236px;
  --gap:20px;
  --radius:10px;
  --radius-sm:6px;
  --shadow:0 1px 2px rgba(28,26,23,.04),0 1px 3px rgba(28,26,23,.03);
  --shadow-lift:0 2px 8px rgba(28,26,23,.07),0 1px 3px rgba(28,26,23,.05);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#141311;
    --surface:#1c1b18;
    --surface-2:#22201d;
    --sidebar:#191816;
    --fg:#f0ece5;
    --fg-2:#d4cec4;
    --muted:#8f877c;
    --faint:#635c53;
    --line:#2e2b27;
    --line-2:#262421;
    --accent:#e08c3c;
    --accent-soft:#2e2114;
    --accent-line:#4a3418;
    --star:#d9a441;
    --up:#5cb87c;
    --up-soft:#16281c;
    --shadow:0 1px 2px rgba(0,0,0,.3);
    --shadow-lift:0 2px 10px rgba(0,0,0,.4);
  }
}
`;

/** 布局与组件样式。 */
export const STYLES = `
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}
::selection{background:var(--accent-soft);color:var(--fg)}

/* ── 骨架：侧边栏 + 主区 ───────────────────────── */
.shell{display:flex;min-height:100vh;align-items:flex-start}
.sidebar{
  width:var(--sidebar-w);flex:0 0 var(--sidebar-w);
  background:var(--sidebar);border-right:1px solid var(--line);
  position:sticky;top:0;height:100vh;overflow-y:auto;
}
/* 品牌 + 搜索固定在侧边栏顶部，不随内容滚走 */
.side-top{
  position:sticky;top:0;z-index:2;background:var(--sidebar);
  padding:20px 0 12px;border-bottom:1px solid var(--line-2);
}
.side-bottom{padding:8px 0 32px}
.main{flex:1;min-width:0;padding:0 var(--gap) 96px}
.wrap{max-width:820px;margin:0 auto}

/* ── 侧边栏 ──────────────────────────────────── */
.brand{display:block;padding:0 18px 12px;text-decoration:none;color:inherit}
/* 窄屏下侧栏整体隐藏，回主页入口在 .main 顶部补一份（样式在底部 860px 媒体查询里）。
   文案是显式的「← 回到主页」——用户实测没人看得出品牌文字能点。 */
.mobile-brand{display:none}
.brand h1{margin:0;font-size:15px;font-weight:650;letter-spacing:.01em;transition:color .15s}
.brand:hover h1{color:var(--accent)}
.brand .sub{color:var(--muted);font-size:12px;margin-top:2px}
.side-search{padding:0 14px 12px}
.side-search input{
  width:100%;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);
  background:var(--surface);color:var(--fg);font-size:13px;font-family:inherit;
}
.side-search input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.side-group{padding:0 10px;margin-bottom:18px}
.side-label{
  font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;
  letter-spacing:.08em;padding:0 8px 6px;
}
.side-link{
  display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:var(--radius-sm);
  color:var(--fg-2);font-size:13px;line-height:1.4;
}
.side-link:hover{background:rgba(128,110,80,.08);color:var(--fg)}
.side-link.active{background:var(--accent-soft);color:var(--accent);font-weight:550}
.side-link .count{margin-left:auto;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.side-link.active .count{color:var(--accent)}
.side-link .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:0 0 6px}
.side-link .date{font-variant-numeric:tabular-nums}

/* ── 页头 ────────────────────────────────────── */
.page-head{
  padding:28px 0 20px;border-bottom:1px solid var(--line);margin-bottom:26px;
  display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;
}
.page-head h2{margin:0;font-size:24px;font-weight:640;letter-spacing:-.01em}
.page-head .meta{color:var(--muted);font-size:12.5px;margin-top:5px}
.page-head .spacer{flex:1}
.btn{
  padding:6px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);
  background:var(--surface);color:var(--fg-2);font-size:13px;cursor:pointer;
  font-family:inherit;transition:border-color .12s,color .12s;
}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:hover{filter:brightness(1.08);color:#fff}

/* ── 章节 ────────────────────────────────────── */
.section{margin-bottom:44px;scroll-margin-top:20px}
.section-head{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.section-head h3{margin:0;font-size:16px;font-weight:620;letter-spacing:-.005em}
.section-head .badge{
  font-size:11px;color:var(--muted);background:var(--surface);border:1px solid var(--line);
  padding:1px 7px;border-radius:20px;font-variant-numeric:tabular-nums;
}
.section-head .rule{flex:1;height:1px;background:var(--line-2)}

/* ── 卡片 ────────────────────────────────────── */
.card{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:14px 16px;margin-bottom:8px;box-shadow:var(--shadow);
  transition:border-color .12s,box-shadow .12s,transform .12s;
}
.card:hover{border-color:var(--accent-line);box-shadow:var(--shadow-lift)}
.card-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.card-title{
  font-size:15px;font-weight:600;line-height:1.4;color:var(--fg);
  overflow-wrap:anywhere;
}
a.card-title{color:var(--fg)}
a.card-title:hover{color:var(--accent)}

/* 来源标签：每张卡片都标来源，扫的时候知道这条从哪来 */
.src{
  font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
  padding:2px 7px;border-radius:4px;white-space:nowrap;flex:0 0 auto;
  border:1px solid transparent;
}
.src-twitter{color:#1d9bf0;background:rgba(29,155,240,.10);border-color:rgba(29,155,240,.22)}
.src-github{color:var(--fg-2);background:var(--surface-2);border-color:var(--line)}
.src-hackernews{color:#ff6600;background:rgba(255,102,0,.10);border-color:rgba(255,102,0,.22)}
.src-zhihu{color:#0f6cbd;background:rgba(15,108,189,.10);border-color:rgba(15,108,189,.22)}
@media (prefers-color-scheme:dark){
  .src-twitter{color:#5ab8f5;background:rgba(29,155,240,.16)}
  .src-hackernews{color:#ff8c4b;background:rgba(255,102,0,.16)}
  .src-zhihu{color:#5aa9f0;background:rgba(15,108,189,.18)}
}

/* 元信息 chip：星数 / 语言 / 今日增量 / points */
.chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chip{
  font-size:11.5px;line-height:1;padding:3px 7px;border-radius:4px;
  background:var(--surface-2);border:1px solid var(--line-2);color:var(--muted);
  font-variant-numeric:tabular-nums;white-space:nowrap;
}
.chip.star{color:var(--star);background:transparent;border-color:transparent;padding-left:0}
.chip.up{color:var(--up);background:var(--up-soft);border-color:transparent}
.chip.lang{color:var(--fg-2)}

/* ── 中英对照：左英右繁，两列对齐 ──────────────── */
.duo{display:grid;grid-template-columns:1fr 1fr;gap:0 28px;align-items:start}
.duo > .en{padding-right:28px;border-right:1px solid var(--line-2)}
.duo > .zh{padding-left:28px}
.duo > .zh:empty{display:none}
.card-sum{color:var(--fg-2);font-size:14px;line-height:1.62}
.card-sum .zh{color:var(--muted)}
/* 夹行必须作用在直接包含文本的列上——挂在 grid 容器 (.card-sum) 上不生效 */
.card-sum.clamp > .en,
.card-sum.clamp > .zh{
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;
}
/* 窄屏：两列堆叠，但保持英文在前 */
@media (max-width:720px){
  .duo{grid-template-columns:1fr;gap:6px}
  .duo > .en{padding-right:0;border-right:0}
  .duo > .zh{padding-left:0}
  .duo > .zh:not(:empty){padding-top:6px;border-top:1px dashed var(--line-2)}
}
.card-foot{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
.card-foot .spacer{flex:1}
.link-btn{
  display:inline-flex;align-items:center;gap:4px;font-size:12.5px;color:var(--accent);
  border:1px solid var(--accent-line);background:var(--accent-soft);
  padding:3px 9px;border-radius:var(--radius-sm);white-space:nowrap;
}
.link-btn:hover{filter:brightness(.97)}
.link-btn.quiet{background:transparent;border-color:transparent;color:var(--muted);padding:3px 4px}
.link-btn.quiet:hover{color:var(--accent);background:transparent}
.link-btn .ext{font-size:10px;opacity:.75}
.expand-btn{
  border:0;background:transparent;color:var(--muted);font-size:12.5px;cursor:pointer;
  padding:3px 4px;font-family:inherit;
}
.expand-btn:hover{color:var(--accent)}

/* ── Twitter 分类 ────────────────────────────── */
.cat{margin-bottom:18px}
.cat-title{
  font-size:13.5px;font-weight:640;color:var(--fg);margin:0 0 10px;
  display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;
}
.cat-title .n{font-size:11px;color:var(--faint);font-weight:400;font-variant-numeric:tabular-nums}
.cat-title .tz{font-size:12px;color:var(--muted);font-weight:400}
.cat-items{list-style:none;padding:0;margin:0}
.cat-items li{padding:11px 0;border-bottom:1px solid var(--line-2)}
.cat-items li:last-child{border-bottom:0}
.cat-items .who{color:var(--accent);font-weight:550}
.cat-items .cite{
  color:var(--muted);font-size:12px;text-decoration:underline;
  text-decoration-color:var(--line);text-underline-offset:3px;
}
.cat-items .cite:hover{color:var(--accent);text-decoration-color:var(--accent)}
.cat-items .duo{font-size:14px;line-height:1.62}
.cat-items .duo > .en{color:var(--fg-2)}
.cat-items .duo > .zh{color:var(--muted)}
/* Twitter 要点的来源标签：与其它章节的卡片保持一致 */
.cat-items .pt-top{margin-bottom:5px}

/* ── 首页日期卡片 ────────────────────────────── */
.day-list{display:grid;gap:8px}
.day-row{
  display:flex;align-items:center;gap:14px;padding:14px 16px;
  background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:var(--shadow);transition:border-color .12s,box-shadow .12s;
}
.day-row:hover{border-color:var(--accent-line);box-shadow:var(--shadow-lift)}
.day-row .date{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;flex:0 0 auto}
.day-row .wd{color:var(--muted);font-size:12.5px;flex:0 0 auto}
.day-row .spacer{flex:1}
.day-row .counts{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.day-row .tot{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto}
.day-row .heads{
  flex-basis:100%;color:var(--faint);font-size:12.5px;margin-top:5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.today-tag{
  font-size:10.5px;font-weight:600;color:var(--accent);background:var(--accent-soft);
  border:1px solid var(--accent-line);padding:1px 6px;border-radius:20px;letter-spacing:.03em;
}

/* ── 搜索结果 ────────────────────────────────── */
.hit{padding:11px 0;border-bottom:1px solid var(--line-2)}
.hit:last-child{border-bottom:0}
.hit .where{color:var(--faint);font-size:11.5px;margin-bottom:3px}
.hit .t{font-size:14px;font-weight:550;margin-bottom:2px}
.hit .s{color:var(--fg-2);font-size:13.5px;line-height:1.6}

/* ── 空状态与提示 ────────────────────────────── */
.empty{color:var(--muted);font-size:14px;padding:40px 0;text-align:center}
.warn-box{
  background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:var(--radius);
  padding:11px 14px;font-size:13px;color:var(--fg-2);margin-bottom:20px;
}
.warn-box b{color:var(--accent)}
.progress{
  font-size:12.5px;color:var(--muted);padding:7px 0;min-height:30px;
  display:flex;align-items:center;gap:8px;
}
.spinner{
  width:11px;height:11px;border:2px solid var(--line);border-top-color:var(--accent);
  border-radius:50%;animation:spin .7s linear infinite;flex:0 0 11px;
}
@keyframes spin{to{transform:rotate(360deg)}}
/* 历史事件的静态标记：已经是过去的事了，不该转圈 */
.dot{
  width:7px;height:7px;border-radius:50%;background:var(--muted);
  flex:0 0 7px;margin:0 2px;
}
.pager{display:flex;justify-content:space-between;gap:12px;margin-top:28px;padding-top:16px;border-top:1px solid var(--line)}

/* ── 浮动目录：可拖动的浮窗 ──────────────────── */
/*
 * 需求：滚动到中间时不用往回滚就能跳转。
 * 做法：右下角常驻一个圆形按钮，点开一个可以拖动的浮窗。
 * 位置存在 localStorage，下次打开还在原处。
 */
/*
 * 目录是「一个整体」：按钮 + 浮窗都挂在 .toc-dock 上。
 * dock 是唯一的定位单位——拖动它，按钮和浮窗一起走，不会分家。
 *
 * 按钮在浮窗的右下角：浮窗绝对定位在 dock 上方，右边缘对齐。
 */
.toc-dock{
  position:fixed;right:18px;bottom:18px;z-index:60;
  /* dock 本身只有按钮那么大，浮窗绝对定位不占空间 */
  width:44px;height:44px;
}
/* 被拖动后改用 left/top 定位，不再贴边 */
.toc-dock.dragged{right:auto;bottom:auto}

.toc-fab{
  width:44px;height:44px;border-radius:50%;
  /* 默认就是实底主题色：米色背景上半透明白底几乎看不见（用户实测），必须一眼能找到 */
  border:1px solid var(--accent);background:var(--accent);color:#fff;
  box-shadow:var(--shadow-lift);cursor:pointer;font-size:17px;line-height:1;
  display:flex;align-items:center;justify-content:center;
  -webkit-tap-highlight-color:transparent;
  /* 按钮也能拖着走 */
  touch-action:none;user-select:none;-webkit-user-select:none;
}
.toc-fab:hover{filter:brightness(1.1)}
/* 展开态反转：浅底色字，与默认实底拉开区别，读作「已打开，可关闭」 */
.toc-fab[aria-expanded="true"]{background:var(--surface);color:var(--accent);border-color:var(--accent-line)}
.toc-fab.dragging{cursor:grabbing}

.toc-float{
  /* 浮窗在按钮左侧：按钮就落在浮窗的右下角 */
  position:absolute;right:calc(100% + 10px);bottom:0;
  width:250px;max-width:calc(100vw - 24px);
  background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  box-shadow:0 8px 28px rgba(28,26,23,.16),0 2px 6px rgba(28,26,23,.08);
  display:flex;flex-direction:column;overflow:hidden;
  max-height:min(70vh,560px);
}
.toc-float[hidden]{display:none}
/* 按钮在浮窗右侧，浮窗默认与按钮底部对齐（按钮在浮窗右下角）。
   空间不够时改为顶部对齐（按钮仍在右下角）。 */
.toc-dock.drop-down .toc-float{bottom:auto;top:0}
.toc-head{
  display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;
  border-bottom:1px solid var(--line-2);background:var(--surface-2);
  cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;
}
.toc-head.dragging{cursor:grabbing}
.toc-title{font-size:12.5px;font-weight:650;letter-spacing:.02em}
.toc-hint{font-size:11px;color:var(--faint);margin-left:auto}
.toc-close{
  border:none;background:none;color:var(--muted);cursor:pointer;font-size:13px;
  padding:2px 4px;line-height:1;font-family:inherit;border-radius:var(--radius-sm);
}
.toc-close:hover{color:var(--fg);background:rgba(128,110,80,.1)}
.toc-body{overflow-y:auto;padding:8px 0;overscroll-behavior:contain}
.toc-search{padding:0 12px 10px}
.toc-search input{
  width:100%;padding:6px 9px;border:1px solid var(--line);border-radius:var(--radius-sm);
  background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit;
}
.toc-search input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.toc-group{padding:0 8px;margin-bottom:14px}
.toc-label{
  font-size:10.5px;font-weight:600;color:var(--faint);text-transform:uppercase;
  letter-spacing:.08em;padding:0 6px 5px;
}
.toc-link{
  display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:var(--radius-sm);
  color:var(--fg-2);font-size:13px;line-height:1.4;
}
.toc-link:hover{background:rgba(128,110,80,.08);color:var(--fg)}
.toc-link.active{background:var(--accent-soft);color:var(--accent);font-weight:550}
.toc-link .count{margin-left:auto;color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.toc-link.active .count{color:var(--accent)}
.toc-top-link{color:var(--muted);font-size:12px;margin:0 8px}

/* ── 窄屏 ────────────────────────────────────── */
@media (max-width:860px){
  .shell{display:block}
  .sidebar{display:none}
  .mobile-brand{display:block;padding:12px 4px 0;font-size:13px;font-weight:550;color:var(--fg-2);text-decoration:none}
  .main{padding:0 14px 72px}
  .page-head h2{font-size:20px}
  .day-row{flex-wrap:wrap;gap:8px}
  .day-row .counts{justify-content:flex-start}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;transition-duration:.01ms!important}
  html{scroll-behavior:auto}
}
`;
