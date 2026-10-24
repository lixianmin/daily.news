// 页面交互：展开/收起、侧边栏抽屉、滚动高亮、搜索、重新生成、SSE 进度。
// 不引框架：这些都是原生 DOM 能做的小事。
(() => {
  const $hits = document.getElementById("hits");
  const $regen = document.getElementById("regen");
  const $progress = document.getElementById("progress");
  const $sidebar = document.getElementById("sidebar");
  const $tocDock = document.getElementById("tocDock");
  const $tocFab = document.getElementById("tocFab");
  const $tocFloat = document.getElementById("tocFloat");
  const $tocHead = document.getElementById("tocHead");
  const $tocClose = document.getElementById("tocClose");
  // 侧边栏和浮动目录各有一个搜索框，都用 data-search 标记
  const $searchInputs = Array.from(document.querySelectorAll("[data-search]"));

  // ---------- 展开/收起 ----------
  // 中英两列一起展开/收起——它们是同一句话的两种语言，展开一半会看不懂
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest(".expand-btn") : null;
    if (button === null) return;

    const card = button.closest(".card");
    const summary = card?.querySelector(".card-sum");
    if (summary === null || summary === undefined) return;

    const clamped = summary.classList.toggle("clamp");
    button.textContent = clamped ? "More ▾" : "Less ▴";
  });

  // ---------- 浮动目录 ----------
  //
  // 按钮 + 浮窗是「一个整体」：都挂在 .toc-dock 上，拖 dock 就一起走。
  // 位置记在 localStorage，下次打开还在原处。
  const TOC_POS_KEY = "daily.news.toc.pos";

  function openToc() {
    if ($tocFloat === null) return;
    $tocFloat.hidden = false;
    $tocFab?.setAttribute("aria-expanded", "true");
    // 浮窗顶部超出屏幕时，把 dock 往下推——
    // 按钮在浮窗右下角，浮窗太高就只能整体下移。
    if ($tocDock !== null && $tocFloat !== null) {
      const height = $tocFloat.offsetHeight || 300;
      const dockTop = $tocDock.getBoundingClientRect().top;
      if (dockTop - height < 0) {
        const shifted = Math.min(
          Math.max(0, -dockTop + height),
          window.innerHeight - $tocDock.offsetHeight,
        );
        $tocDock.classList.add("dragged");
        $tocDock.style.left = `${$tocDock.getBoundingClientRect().left}px`;
        $tocDock.style.top = `${dockTop + shifted}px`;
      }
    }

    // 首次打开且没存过位置：贴着按钮放。
    // 注意要切到 left/top 定位——dock 默认是 right/bottom 贴边，
    // 两个一起用会打架。
    if ($tocDock !== null && !$tocDock.classList.contains("dragged")) {
      const fab = $tocFab?.getBoundingClientRect();
      if (fab !== undefined) {
        const width = $tocFloat.offsetWidth || 250;
        const height = $tocFloat.offsetHeight || 300;
        // 浮窗在按钮左侧，所以 dock 的左边要留出浮窗的宽度
        const left = Math.max(0, Math.min(fab.left - width - 10, window.innerWidth - width - 10));
        const top = Math.max(0, Math.min(fab.top + fab.height - height, window.innerHeight - height));
        $tocDock.classList.add("dragged");
        $tocDock.style.left = `${left}px`;
        $tocDock.style.top = `${top}px`;
      }
    }
  }

  function closeToc() {
    if ($tocFloat === null) return;
    $tocFloat.hidden = true;
    $tocFab?.setAttribute("aria-expanded", "false");
    $tocDock?.classList.remove("drop-down");
  }

  function toggleToc() {
    if ($tocFloat === null) return;
    if ($tocFloat.hidden) openToc();
    else closeToc();
  }

  $tocFab?.addEventListener("click", toggleToc);
  $tocClose?.addEventListener("click", closeToc);

  // 点面板里的链接后收起（跳转后不让浮窗挡住内容）
  $tocFloat?.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a") !== null) {
      // 章节锚点跳转后要等滚动结束再关，否则会被滚动动画带跑
      const isAnchor = event.target.getAttribute("href")?.startsWith("#") === true;
      if (isAnchor) setTimeout(closeToc, 260);
      else closeToc();
    }
  });

  // --- 拖动：拖 dock，按钮和浮窗一起走 ---
  function dockLeft() {
    if ($tocDock === null) return 0;
    // 未拖动过时用 getBoundingClientRect 拿实际位置
    if (!$tocDock.classList.contains("dragged")) return $tocDock.getBoundingClientRect().left;
    return $tocDock.offsetLeft;
  }

  function dockTop() {
    if ($tocDock === null) return 0;
    if (!$tocDock.classList.contains("dragged")) return $tocDock.getBoundingClientRect().top;
    return $tocDock.offsetTop;
  }

  function moveDock(left, top) {
    if ($tocDock === null) return;
    const maxLeft = window.innerWidth - $tocDock.offsetWidth;
    const maxTop = window.innerHeight - $tocDock.offsetHeight;
    const x = Math.max(dockMinLeft(), Math.min(left, maxLeft));
    const y = Math.max(0, Math.min(top, maxTop));
    $tocDock.classList.add("dragged");
    $tocDock.style.left = `${x}px`;
    $tocDock.style.top = `${y}px`;
  }

  /**
   * dock 的可拖动范围。
   *
   * 浮窗在按钮左侧，所以 dock 不能拖到屏幕最左边——不然浮窗会出屏。
   * 浮窗打开时才收紧这个限制，关闭时按钮可以贴到任意位置。
   */
  function dockMinLeft() {
    if ($tocFloat === null || $tocFloat.hidden) return 0;
    const width = $tocFloat.offsetWidth || 250;
    // dock 左边 - 浮窗宽度 - 间距 >= 0
    return width + 10;
  }

  function saveDockPos() {
    if ($tocDock === null) return;
    if (!$tocDock.classList.contains("dragged")) return;
    try {
      localStorage.setItem(
        TOC_POS_KEY,
        JSON.stringify({ left: $tocDock.offsetLeft, top: $tocDock.offsetTop }),
      );
    } catch {
      // 隐私模式下 localStorage 可能不可写，忽略
    }
  }

  function restoreDockPos() {
    if ($tocDock === null) return;
    try {
      const raw = localStorage.getItem(TOC_POS_KEY);
      if (raw === null) return;
      const pos = JSON.parse(raw);
      if (typeof pos?.left === "number" && typeof pos?.top === "number") {
        $tocDock.classList.add("dragged");
        $tocDock.style.left = `${pos.left}px`;
        $tocDock.style.top = `${pos.top}px`;
      }
      // 存的位置可能在更小的屏幕上（换了设备/窗口），夹回可视范围
      moveDock($tocDock.offsetLeft, $tocDock.offsetTop);
    } catch {
      // 存的格式不对就用默认位置
    }
  }

  /**
   * 给一个元素挂上拖动能力。
   *
   * 拖动的是整个 dock——不管从按钮还是从浮窗标题栏起手，按钮和浮窗都跟着走。
   */
  function makeDraggable(handle) {
    let dragState = null;

    handle.addEventListener("pointerdown", (event) => {
      // 点关闭按钮不触发拖动
      if (event.target instanceof Element && event.target.closest(".toc-close") !== null) return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      if ($tocDock === null) return;

      dragState = {
        offsetX: event.clientX - dockLeft(),
        offsetY: event.clientY - dockTop(),
        moved: false,
      };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (dragState === null) return;
      // 移动超过阈值才算拖动，否则算点击（手抖一下不该把窗口挪走）
      const dx = Math.abs(event.clientX - (dockLeft() + dragState.offsetX));
      const dy = Math.abs(event.clientY - (dockTop() + dragState.offsetY));
      if (!dragState.moved && dx < 3 && dy < 3) return;
      dragState.moved = true;
      moveDock(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
    });

    const endDrag = () => {
      if (dragState === null) return;
      const moved = dragState.moved;
      dragState = null;
      handle.classList.remove("dragging");
      if (moved) saveDockPos();
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);

    // 拖动之后紧跟的 click 不该触发开合
    handle.addEventListener("click", (event) => {
      if (dragState !== null && dragState.moved) {
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
  }

  if ($tocHead !== null) {
    $tocHead.addEventListener("pointerdown", () => $tocHead.classList.add("dragging"));
    makeDraggable($tocHead);
  }
  // 按钮也能拖：按住挪动是拖，点一下是开合
  if ($tocFab !== null) makeDraggable($tocFab);

  restoreDockPos();

  // ---------- 滚动高亮当前章节 ----------
  const spyLinks = Array.from(document.querySelectorAll("[data-spy]"));
  if (spyLinks.length > 0) {
    const sections = spyLinks
      .map((link) => document.getElementById(link.getAttribute("data-spy") ?? ""))
      .filter((element) => element !== null);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = entry.target.id.replace(/^sec-/, "");
          for (const link of spyLinks) {
            link.classList.toggle("active", link.getAttribute("data-spy") === id);
          }
        }
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const section of sections) observer.observe(section);
  }

  // ---------- 搜索 ----------
  let searchTimer = 0;
  let lastQuery = "";

  function escapeHtml(text) {
    // 用字符码构造实体字面量：写 "&" 这类字面量容易被工具链的 HTML 实体解码改写
    const AMP = String.fromCharCode(38);
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);
    const QUOT = String.fromCharCode(34);
    const APOS = String.fromCharCode(39);
    return String(text)
      .split(AMP).join(AMP + "amp;")
      .split(LT).join(AMP + "lt;")
      .split(GT).join(AMP + "gt;")
      .split(QUOT).join(AMP + "quot;")
      .split(APOS).join(AMP + "#39;");
  }

  function safeUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url) ? escapeHtml(url) : null;
  }

  async function runSearch(query) {
    const trimmed = query.trim();
    if (trimmed === "") {
      $hits.innerHTML = "";
      lastQuery = "";
      return;
    }
    lastQuery = trimmed;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (lastQuery !== trimmed) return;
      renderHits(payload.hits ?? []);
    } catch (error) {
      $hits.innerHTML = `<div class="empty">搜索失败：${escapeHtml(String(error))}</div>`;
    }
  }

  function renderHits(hits) {
    if (hits.length === 0) {
      $hits.innerHTML = `<div class="empty">没有匹配的结果。</div>`;
      return;
    }
    $hits.innerHTML =
      `<div class="page-head"><div><h2>搜索结果</h2><div class="meta">${hits.length} 条</div></div></div>` +
      hits
        .map((hit) => {
          const url = safeUrl(hit.url);
          const title = url
            ? `<a class="t" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(hit.title)}</a>`
            : `<div class="t">${escapeHtml(hit.title)}</div>`;
          return `<div class="hit">
  <div class="where">${escapeHtml(hit.date)} · ${escapeHtml(hit.section)}</div>
  ${title}
  <div class="s">${escapeHtml(hit.en)}</div>
</div>`;
        })
        .join("");
  }

  // 侧边栏与浮动目录各有一个搜索框，都接上
  for (const input of $searchInputs) {
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const value = input.value;
      searchTimer = setTimeout(() => void runSearch(value), 220);
    });
  }

  // ---------- 进度 ----------
  //
  // 刷新只认实时事件：服务端重放的历史事件里也有 `done`，
  // 当成实时的就会每次加载都刷新一次——形成死循环。
  let reloading = false;

  function showProgress(event) {
    if ($progress === null) return;
    const isLive = event.live === true;
    const ratio = typeof event.ratio === "number" ? ` · ${Math.round(event.ratio * 100)}%` : "";
    // 历史事件是静态事实（比如「生成完成」），不该一直转圈——
    // 那个永不停歇的转圈看起来就像页面卡住或反复刷新。
    const marker = isLive ? '<span class="spinner"></span>' : '<span class="dot"></span>';
    $progress.innerHTML = `${marker}${escapeHtml(event.message)}${escapeHtml(ratio)}`;

    if (event.stage === "done" && isLive && !reloading) {
      reloading = true;
      setTimeout(() => location.reload(), 1200);
    }
  }

  function connectProgress() {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/stream");
    source.addEventListener("message", (event) => {
      try {
        showProgress(JSON.parse(event.data));
      } catch {
        // 心跳或非 JSON，忽略
      }
    });
  }

  // ---------- 重新生成 ----------
  let state = "idle";

  function syncRegenButton() {
    if ($regen === null) return;
    if (state === "starting") {
      $regen.disabled = true;
      $regen.textContent = "触发中…";
    } else if (state === "running") {
      $regen.disabled = true;
      $regen.textContent = "生成中…";
      // 生成可能要几分钟，别一直卡住按钮
      setTimeout(() => {
        state = "idle";
        syncRegenButton();
      }, 5 * 60 * 1000);
    } else {
      $regen.disabled = false;
      $regen.textContent = "重新生成";
    }
  }

  $regen?.addEventListener("click", async () => {
    state = "starting";
    syncRegenButton();
    try {
      const response = await fetch("/api/regenerate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({}));
      state = response.ok ? "running" : "idle";
      if ($progress !== null) {
        $progress.textContent = response.ok
          ? "已开始生成，进度见上"
          : `未启动：${payload.reason ?? payload.error ?? response.status}`;
      }
    } catch (error) {
      state = "idle";
      if ($progress !== null) $progress.textContent = `触发失败：${String(error)}`;
    }
    syncRegenButton();
  });

  async function syncInitialState() {
    try {
      const response = await fetch("/health");
      if (!response.ok) return;
      const health = await response.json();
      if (health.running === true) {
        state = "running";
        syncRegenButton();
      }
    } catch {
      // 拿不到健康状态不影响页面使用
    }
  }

  connectProgress();
  void syncInitialState();
})();
