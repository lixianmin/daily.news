// 首页交互：搜索 + 重新生成 + SSE 进度。
// 不引框架：三块功能，手写比接构建链便宜。
(() => {
  const $q = document.getElementById("q");
  const $hits = document.getElementById("hits");
  const $regen = document.getElementById("regen");
  const $progress = document.getElementById("progress");

  // ---------- 搜索 ----------
  let searchTimer = 0;
  let lastQuery = "";

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
      // 期间用户又敲了字，丢掉这次结果
      if (lastQuery !== trimmed) return;
      renderHits(payload.hits ?? []);
    } catch (error) {
      $hits.innerHTML = `<p class="warn">搜索失败：${escapeHtml(String(error))}</p>`;
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url) ? escapeHtml(url) : null;
  }

  function renderHits(hits) {
    if (hits.length === 0) {
      $hits.innerHTML = `<p class="muted">没有匹配的结果。</p>`;
      return;
    }
    $hits.innerHTML =
      `<p class="muted">${hits.length} 条结果</p>` +
      hits
        .map((hit) => {
          const url = safeUrl(hit.url);
          const title = url
            ? `<a href="${url}">${escapeHtml(hit.title)}</a>`
            : escapeHtml(hit.title);
          const zh = hit.zh ? `<div class="zh muted">${escapeHtml(hit.zh)}</div>` : "";
          return `<div class="hit">
  <div class="where">${escapeHtml(hit.date)} · ${escapeHtml(hit.section)}</div>
  <div class="title">${title}</div>
  <div class="en">${escapeHtml(hit.en)}</div>${zh}
</div>`;
        })
        .join("");
  }

  if ($q) {
    $q.addEventListener("input", () => {
      clearTimeout(searchTimer);
      // 输入即搜，但压一压节奏，别每个字符都打一次请求
      searchTimer = setTimeout(() => void runSearch($q.value), 220);
    });
  }

  // ---------- 进度 ----------
  function showProgress(event) {
    if (!$progress) return;
    const ratio = typeof event.ratio === "number" ? ` (${Math.round(event.ratio * 100)}%)` : "";
    $progress.textContent = `${event.message}${ratio}`;
    if (event.stage === "done") {
      // 生成完成：刷新列表让新的一天出现
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
    source.addEventListener("error", () => {
      // 断线由浏览器自动重连，不打日志噪音
    });
  }

  // ---------- 重新生成 ----------
  if ($regen) {
    $regen.addEventListener("click", async () => {
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
        if ($progress) {
          $progress.textContent = response.ok
            ? "已开始生成，进度见上"
            : `未启动：${payload.reason ?? payload.error ?? response.status}`;
        }
      } catch (error) {
        state = "idle";
        if ($progress) $progress.textContent = `触发失败：${String(error)}`;
      }
      syncRegenButton();
    });
  }

  let state = "idle";

  function syncRegenButton() {
    if (!$regen) return;
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

  // ---------- 启动时看是否已在跑 ----------
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
