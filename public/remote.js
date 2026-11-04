// Remote Control 页面：两个按钮 → 两个接口。
// 不引框架：原生 fetch 就够。
(() => {
  const $status = document.getElementById("remoteStatus");
  const $wake = document.getElementById("remoteWake");
  const $sleep = document.getElementById("remoteSleep");

  function setStatus(text, kind) {
    if ($status === null) {
      return;
    }
    $status.textContent = text;
    $status.className = kind === undefined ? "remote-status" : `remote-status ${kind}`;
  }

  async function send(button, url, okText) {
    if (button === null) {
      return;
    }
    button.disabled = true;
    setStatus("执行中…");
    try {
      const response = await fetch(url, { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatus(payload.message ?? `失败（HTTP ${response.status}）`, "err");
        return;
      }
      setStatus(okText, "ok");
    } catch (error) {
      setStatus(`请求失败：${String(error)}`, "err");
    } finally {
      button.disabled = false;
    }
  }

  $wake?.addEventListener("click", () => {
    void send($wake, "/api/remote/wake", "已唤醒屏幕");
  });

  $sleep?.addEventListener("click", () => {
    void send($sleep, "/api/remote/sleep", "已关闭屏幕（显示器休眠，主机继续运行）");
  });
})();
