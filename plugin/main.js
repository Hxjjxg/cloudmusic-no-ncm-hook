(function () {
  "use strict";
  const root = globalThis;
  const host = typeof plugin === "object" ? plugin : null;
  const previous = root.cloudmusicNoNCM;
  if (previous && typeof previous.dispose === "function") previous.dispose();

  let controller;
  let retryTimer;
  let retryDeadline;
  let unloaded = false;

  function readConfig(key, fallback) {
    try { return host ? host.getConfig(key, fallback) : fallback; }
    catch (_) { return fallback; }
  }

  function writeConfig(key, value) {
    try { if (host) host.setConfig(key, value); }
    catch (error) { console.warn("[CloudmusicNoNCM] 设置保存失败", error); }
  }

  function start() {
    if (unloaded || controller) return;
    controller = root.CloudmusicNoNCM.createHook({
      enabled: readConfig("enabled", true),
      captureUrls: readConfig("captureUrls", true),
    });
    if (!controller.install()) {
      retryDeadline = Date.now() + 30000;
      retryTimer = setInterval(() => {
        if (controller.install() || Date.now() >= retryDeadline) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, 250);
    }
  }

  function dispose() {
    unloaded = true;
    clearInterval(retryTimer);
    root.removeEventListener("pagehide", dispose);
    return controller ? controller.dispose() : true;
  }

  const api = {
    status: () => controller ? controller.status() : { installed: false },
    getRecords: () => controller ? controller.getRecords() : [],
    clearRecords: () => controller && controller.clearRecords(),
    setEnabled(value) {
      if (controller) controller.setEnabled(value);
      writeConfig("enabled", Boolean(value));
    },
    setCaptureUrls(value) {
      if (controller) controller.setCaptureUrls(value);
      writeConfig("captureUrls", Boolean(value));
    },
    install: () => { start(); return controller ? controller.install() : false; },
    dispose,
    async exportRecords() {
      const text = JSON.stringify({
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        status: api.status(), records: api.getRecords(),
      }, null, 2);
      const name = "cloudmusic-no-ncm-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      if (root.betterncm?.fs?.writeFileText && root.betterncm?.app?.getDataPath) {
        const base = await root.betterncm.app.getDataPath();
        const path = base.replace(/[\\/]$/, "") + "/" + name;
        const result = await root.betterncm.fs.writeFileText(path, text);
        if (result === false) throw new Error("记录写入失败");
        return path;
      }
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return name;
    },
  };
  root.cloudmusicNoNCM = api;
  root.addEventListener("pagehide", dispose);

  if (host) {
    host.onLoad(start);
    host.onConfig(() => {
      start();
      const panel = document.createElement("div");
      panel.style.cssText = "padding:16px;line-height:1.8;max-width:720px";
      const title = document.createElement("h2");
      title.textContent = "保留原始音频格式";
      panel.appendChild(title);
      const description = document.createElement("p");
      description.textContent = "保留新下载歌曲的 MP3 / FLAC 格式，可记录并导出下载链接。";
      panel.appendChild(description);
      const status = document.createElement("p");
      const message = document.createElement("p");
      function refresh() {
        const s = api.status();
        status.textContent = (s.disposed ? "已停止，重载页面后可重新启用" :
          s.installed ? (s.enabled ? "运行中" : "已暂停") : "等待连接，可点击重新连接") +
          "；已处理 " + (s.patched || 0) + " 次，记录 " + (s.records || 0) + " 条。";
      }
      function checkbox(text, key, setter) {
        const label = document.createElement("label");
        label.style.cssText = "display:block;margin:10px 0";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(api.status()[key]);
        input.addEventListener("change", () => { setter(input.checked); refresh(); });
        label.append(input, document.createTextNode(" " + text));
        panel.appendChild(label);
      }
      checkbox("启用：保留 MP3 / FLAC 格式", "enabled", api.setEnabled);
      checkbox("记录音频下载链接（当前页面内最多 200 条记录）", "captureUrls", api.setCaptureUrls);
      panel.appendChild(status);
      function button(text, action) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.style.cssText = "margin:4px 8px 4px 0;padding:4px 12px";
        button.addEventListener("click", async () => {
          try { await action(); refresh(); }
          catch (error) { message.textContent = String(error.message || error); }
        });
        panel.appendChild(button);
      }
      button("刷新状态", refresh);
      button("重新连接", () => api.install());
      button("导出记录", async () => { message.textContent = "已导出：" + await api.exportRecords(); });
      button("清空记录", () => { api.clearRecords(); message.textContent = "记录已清空"; });
      const note = document.createElement("p");
      note.textContent = "记录只保存在当前页面内存中，重载后清空。已下载的 NCM 文件保持原状。";
      panel.append(note, message);
      const links = document.createElement("p");
      for (const [text, url] of [
        ["源代码", "https://github.com/Hxjjxg/cloudmusic-no-ncm-hook"],
        ["问题反馈", "https://github.com/Hxjjxg/cloudmusic-no-ncm-hook/issues"],
      ]) {
        const link = document.createElement("a");
        link.textContent = text;
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.style.marginRight = "16px";
        link.addEventListener("click", async (event) => {
          if (!root.betterncm?.ncm?.openUrl) return;
          event.preventDefault();
          try { await root.betterncm.ncm.openUrl(url); }
          catch (error) { message.textContent = "打开链接失败：" + error.message; }
        });
        links.appendChild(link);
      }
      panel.appendChild(links);
      refresh();
      return panel;
    });
  } else {
    start();
  }
})();
