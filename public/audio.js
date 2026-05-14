const state = { results: [], previewIndex: null, resolving: {} };
const $ = (selector) => document.querySelector(selector);

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "请求失败");
  return data;
}

function setStatus(text) {
  $("#status").textContent = text;
}

function setProgress(progress, text = "") {
  $("#progressFill").style.width = `${Math.max(0, Math.min(100, progress || 0))}%`;
  $("#progressText").textContent = text || "空闲";
}

async function pollJob(id, onDone) {
  while (true) {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    setProgress(job.progress, job.message || job.label);
    if (job.status === "done") return onDone(job.result);
    if (job.status === "error") throw new Error(job.error || job.message || "任务失败");
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  if (h) return `${h}小时${m}分`;
  return `${m}分`;
}

function preview(item) {
  if (state.resolving[state.previewIndex]) return `<div class="preview-fallback">正在准备站内试听。</div>`;
  if (!item.bvid) return `<div class="preview-fallback">暂时无法解析播放器。</div>`;
  return `<div class="preview-frame"><iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(item.bvid)}&autoplay=0" allowfullscreen="true" scrolling="no" referrerpolicy="no-referrer"></iframe></div>`;
}

function renderResults() {
  const root = $("#audioResults");
  if (!state.results.length) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = state.results.map((item, index) => `
    <article class="review-track">
      <div class="review-track-head">
        <div class="track-title"><span>${String(index + 1).padStart(2, "0")}</span><strong>${item.title}</strong></div>
        <div class="track-summary">${item.kind} · ${formatDuration(item.duration)} · 评分 ${item.score}</div>
      </div>
      <div class="candidate-list">
        <div class="candidate-option audio-result-row">
          <span>
            <strong>${item.uploader || "未知 UP"}</strong>
            <small>${item.viewCount || 0} 播放 · ${item.url}</small>
          </span>
          <button type="button" data-preview="${index}">${state.previewIndex === index ? "收起" : "试听"}</button>
          <button type="button" class="primary" data-download="${index}">下载</button>
        </div>
        ${state.previewIndex === index ? preview(item) : ""}
      </div>
    </article>
  `).join("");
  root.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.preview);
      state.previewIndex = state.previewIndex === index ? null : index;
      renderResults();
      if (state.previewIndex === index && !state.results[index].bvid) {
        await resolveResult(index);
      }
    });
  });
  root.querySelectorAll("[data-download]").forEach((button) => {
    button.addEventListener("click", () => downloadItem(Number(button.dataset.download)).catch((error) => setStatus(error.message)));
  });
}

async function resolveResult(index) {
  const item = state.results[index];
  if (!item) return;
  state.resolving[index] = true;
  renderResults();
  try {
    const resolved = await api(`/api/audio-resolve?url=${encodeURIComponent(item.url)}`);
    state.results[index] = {
      ...item,
      ...resolved,
      score: item.score
    };
  } catch (error) {
    setStatus(error.message);
  } finally {
    state.resolving[index] = false;
    renderResults();
  }
}

async function searchAudio() {
  const query = $("#audioQuery").value.trim();
  if (!query) return;
  setStatus("正在搜索 B 站有声内容。");
  setProgress(5, "搜索中");
  state.results = await api(`/api/audio-search?q=${encodeURIComponent(query)}&limit=12`);
  state.previewIndex = null;
  renderResults();
  setProgress(100, "搜索完成");
  setStatus(state.results.length ? `找到 ${state.results.length} 个结果。` : "没有找到结果。");
}

async function downloadItem(index) {
  if (!$("#rightsCheck").checked) {
    setStatus("请先确认你有权下载所选内容。");
    return;
  }
  const item = state.results[index];
  if (!item) return;
  setStatus(`正在下载：${item.title}`);
  setProgress(1, "准备下载");
  const job = await api("/api/download-audio-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: item.title, url: item.url, iHaveRights: true })
  });
  await pollJob(job.id, async (result) => {
    setStatus(result.status === "downloaded" ? `下载完成：${result.savedPath}` : "下载命令已执行，但没有找到输出文件。");
    setProgress(100, result.savedPath || "下载结束");
  });
}

$("#audioSearch").addEventListener("click", () => searchAudio().catch((error) => setStatus(error.message)));
$("#audioQuery").addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchAudio().catch((error) => setStatus(error.message));
});
