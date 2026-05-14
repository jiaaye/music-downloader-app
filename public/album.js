const params = new URLSearchParams(location.search);
const artist = params.get("artist") || "";
const album = params.get("album") || "";
const state = { scan: null, previewIndex: null };

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

function renderPreview(source) {
  if (!source?.bvid) return `<a href="${source?.url || "#"}" target="_blank" rel="noreferrer">打开 B 站试听</a>`;
  const src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(source.bvid)}&autoplay=0`;
  return `<div class="preview-frame"><iframe src="${src}" allowfullscreen="true" scrolling="no" referrerpolicy="no-referrer"></iframe></div>`;
}

function renderReview() {
  const root = $("#reviewList");
  if (!state.scan) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = state.scan.tracks.map((track, trackIndex) => {
    const options = track.candidates.map((candidate, candidateIndex) => `
      <label class="candidate-option">
        <input type="radio" name="track-${trackIndex}" value="${candidate.url}" ${candidate.url === track.selected ? "checked" : ""} />
        <span>
          <strong>${candidate.title}</strong>
          <small>${candidate.sourceType} · ${candidate.matchLevel} · ${candidate.uploader || "未知 UP"} · 评分 ${candidate.score}</small>
        </span>
        <button type="button" data-preview="${trackIndex}:${candidateIndex}">试听</button>
      </label>
      ${state.previewIndex === `${trackIndex}:${candidateIndex}` ? renderPreview(candidate) : ""}
    `).join("");
    return `
      <article class="review-track">
        <div class="review-track-head">
          <label>
            <input type="checkbox" data-enabled="${trackIndex}" ${track.selected ? "checked" : ""} />
            <span class="track-title"><span>${String(track.track).padStart(2, "0")}</span><strong>${track.song}</strong></span>
          </label>
          <div class="track-summary">${track.candidates.length} 个候选 · ${track.selected ? "已选择" : "跳过"}</div>
        </div>
        <div class="candidate-list">${options || '<div class="empty">没有找到候选源。</div>'}</div>
      </article>
    `;
  }).join("");

  root.querySelectorAll("[data-enabled]").forEach((input) => {
    input.addEventListener("change", () => {
      const track = state.scan.tracks[Number(input.dataset.enabled)];
      track.selected = input.checked ? (track.candidates[0]?.url || "") : "";
      renderReview();
    });
  });
  root.querySelectorAll("input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => {
      const index = Number(input.name.replace("track-", ""));
      state.scan.tracks[index].selected = input.value;
    });
  });
  root.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      state.previewIndex = state.previewIndex === button.dataset.preview ? null : button.dataset.preview;
      renderReview();
    });
  });
}

async function scanAlbum() {
  setStatus("正在扫描整张专辑候选源。");
  setProgress(1, "准备扫描");
  const job = await api("/api/scan-album-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artist, album })
  });
  await pollJob(job.id, async (result) => {
    state.scan = result;
    renderReview();
    setStatus(`扫描完成：${result.total} 首。请试听、换源或取消不需要的歌曲。`);
    setProgress(100, "扫描完成");
  });
}

async function downloadSelected() {
  if (!state.scan) {
    setStatus("请先扫描候选源。");
    return;
  }
  if (!$("#rightsCheck").checked) {
    setStatus("请先确认你有权下载所选内容。");
    return;
  }
  const items = state.scan.tracks
    .filter((track) => track.selected)
    .map((track) => ({
      artist: state.scan.artist,
      album: state.scan.album,
      song: track.song,
      url: track.selected
    }));
  if (!items.length) {
    setStatus("没有选中的歌曲。");
    return;
  }
  setStatus(`正在下载 ${items.length} 首歌曲。`);
  const job = await api("/api/download-selection-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ iHaveRights: true, items })
  });
  await pollJob(job.id, async (result) => {
    setStatus(`下载完成：${result.downloaded}/${result.total} 首，跳过 ${result.skipped} 首。`);
    setProgress(100, "下载完成");
  });
}

$("#albumTitle").textContent = album || "未选择专辑";
$("#albumMeta").textContent = artist;
$("#scanAlbum").addEventListener("click", () => scanAlbum().catch((error) => setStatus(error.message)));
$("#downloadSelected").addEventListener("click", () => downloadSelected().catch((error) => setStatus(error.message)));
