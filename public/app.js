const state = {
  artists: [],
  profile: null,
  album: null,
  song: null,
  candidates: [],
  previewIndex: null,
  onlineArtists: [],
  onlineSongs: [],
  pendingLocate: null,
  config: null,
  query: "",
  filter: ""
};

const $ = (selector) => document.querySelector(selector);

function norm(value) {
  return String(value || "").toLowerCase().replace(/[\s._-]+/g, "");
}

function applyKnownTitleAliases(value) {
  return String(value || "")
    .replace(/达拉蹦吧/g, "达拉崩吧")
    .replace(/達拉蹦吧/g, "达拉崩吧")
    .replace(/達拉崩吧/g, "达拉崩吧");
}

function editDistance(a, b) {
  const left = Array.from(norm(applyKnownTitleAliases(a)));
  const right = Array.from(norm(applyKnownTitleAliases(b)));
  if (!left.length || !right.length) return Math.max(left.length, right.length);
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= right.length; j += 1) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[right.length];
}

function titleSimilarity(a, b) {
  const left = norm(applyKnownTitleAliases(a));
  const right = norm(applyKnownTitleAliases(b));
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.92;
  const distance = editDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function closestOnlineSongTitle(inferredSong, songs) {
  let best = { title: applyKnownTitleAliases(inferredSong), score: 0 };
  for (const song of songs) {
    const title = song.displaySong || song.song;
    const score = titleSimilarity(inferredSong, title);
    if (score > best.score) best = { title, score };
  }
  return best.score >= 0.72 ? best.title : best.title;
}

function inferSongFromQuery(query, artistName) {
  const rawParts = String(query || "").trim().split(/\s+/).filter(Boolean);
  const artistNorm = norm(artistName);
  const remainingParts = rawParts.filter((part) => norm(part) !== artistNorm);
  if (remainingParts.length && remainingParts.length < rawParts.length) return applyKnownTitleAliases(remainingParts.join(" "));

  const compactQuery = String(query || "").trim();
  const artistIndex = compactQuery.indexOf(artistName);
  if (artistIndex >= 0) {
    const before = compactQuery.slice(0, artistIndex).trim();
    const after = compactQuery.slice(artistIndex + artistName.length).trim();
    return applyKnownTitleAliases([before, after].filter(Boolean).join(" ").trim());
  }
  return "";
}

function addInferredSongs(query, artists, songs) {
  const next = [...songs];
  for (const artist of artists.slice(0, 3)) {
    if (Number(artist.score || 0) < 85) continue;
    const rawInferredSong = inferSongFromQuery(query, artist.name);
    if (!rawInferredSong || norm(rawInferredSong) === norm(artist.name)) continue;
    const inferredSong = closestOnlineSongTitle(rawInferredSong, songs);
    const exists = next.some((song) => (
      norm(song.displayArtistName || song.artistName) === norm(artist.name) &&
      norm(applyKnownTitleAliases(song.displaySong || song.song)).includes(norm(inferredSong))
    ));
    if (exists) continue;
    next.push({
      type: "recording",
      artistId: artist.id,
      artistName: artist.name,
      displayArtistName: artist.name,
      song: inferredSong,
      displaySong: inferredSong,
      album: inferredSong,
      displayAlbum: inferredSong,
      score: artist.score,
      inferred: true
    });
  }
  return next.sort((a, b) => Number(Boolean(b.inferred)) - Number(Boolean(a.inferred)) || Number(b.score || 0) - Number(a.score || 0));
}

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
  let keepGoing = true;
  while (keepGoing) {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    setProgress(job.progress, job.message || job.label);
    if (job.status === "done") {
      keepGoing = false;
      await onDone(job.result);
    } else if (job.status === "error") {
      keepGoing = false;
      throw new Error(job.error || job.message || "任务失败");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
}

function openAlbumPage() {
  if (!state.profile || !state.album) return;
  const url = `/album.html?artist=${encodeURIComponent(state.profile.name)}&album=${encodeURIComponent(state.album.album)}`;
  window.open(url, "_blank");
}

function renderArtists() {
  const list = $("#artistList");
  const query = norm(state.query);
  const artists = query
    ? state.artists.filter((artist) => norm(artist.name).includes(query))
    : state.artists;
  if (!artists.length) {
    list.innerHTML = '<div class="empty">还没有本地曲库。</div>';
    return;
  }
  list.innerHTML = artists.map((artist) => `
    <button data-artist="${artist.name}">
      <strong>${artist.name}</strong>
      <span>${artist.albumCount} / ${artist.songCount}</span>
    </button>
  `).join("");
  list.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => loadProfile(button.dataset.artist));
  });
}

function renderSearchResults(results = []) {
  const box = $("#searchResults");
  if (!state.query) {
    box.innerHTML = "";
    return;
  }
  if (!results.length) {
    box.innerHTML = '<div class="empty">没有搜索结果。</div>';
    return;
  }
  box.innerHTML = results.map((item) => `
    <article class="search-result" data-artist="${item.artist}" data-album="${item.album}" data-song="${item.song}" data-type="${item.type}">
      <strong>${item.label}</strong>
      <span>${item.type} · ${item.detail}</span>
    </article>
  `).join("");
  box.querySelectorAll(".search-result").forEach((row) => {
    row.addEventListener("click", async () => {
      await loadProfile(row.dataset.artist);
      if (row.dataset.album) selectAlbum(row.dataset.album);
      if (row.dataset.song) selectSong(row.dataset.song);
    });
  });
}

function renderOnlineResults() {
  const box = $("#onlineResults");
  if (!state.onlineArtists.length && !state.onlineSongs.length) {
    box.innerHTML = "";
    return;
  }
  const artistHtml = state.onlineArtists.map((artist, index) => `
    <article class="search-result">
      <strong>${artist.name}</strong>
      <span>${artist.type || "artist"} · ${artist.country || "未知地区"} · ${artist.disambiguation || "MusicBrainz"} · 匹配 ${artist.score}</span>
      <button class="primary" data-index="${index}">建立本地曲库</button>
    </article>
  `).join("");
  const songHtml = state.onlineSongs.map((song, index) => `
    <article class="search-result">
      <strong>${song.displaySong}</strong>
      <span>${song.inferred ? "song · B站兜底" : "song"} · ${song.displayArtistName}${song.displayAlbum ? ` / ${song.displayAlbum}` : ""} · 匹配 ${song.score}</span>
      <button class="primary" data-song-index="${index}">建库并定位到下载源</button>
    </article>
  `).join("");
  box.innerHTML = songHtml + artistHtml;
  box.querySelectorAll("[data-index]").forEach((button) => {
    button.addEventListener("click", () => buildLibrary(Number(button.dataset.index)));
  });
  box.querySelectorAll("[data-song-index]").forEach((button) => {
    button.addEventListener("click", () => buildLibraryFromSong(Number(button.dataset.songIndex)));
  });
}

function renderProfile() {
  const profile = state.profile;
  $("#artistName").textContent = profile?.name || "未选择";
  $("#albumCount").textContent = `${profile?.albumCount || 0} 张专辑`;
  $("#songCount").textContent = `${profile?.songCount || 0} 首歌`;
  const albumList = $("#albumList");
  if (!profile) {
    albumList.className = "album-list empty";
    albumList.textContent = "选择一个歌手后显示专辑。";
    return;
  }
  albumList.className = "album-list";
  const filter = norm(state.filter);
  const albums = filter
    ? profile.albums.filter((album) => (
      norm(album.album).includes(filter) ||
      album.songs.some((song) => norm(song).includes(filter))
    ))
    : profile.albums;
  albumList.innerHTML = albums.map((album) => `
    <article class="album-card ${state.album?.album === album.album ? "active" : ""}" data-album="${album.album}">
      <strong>${album.album}</strong>
      <span>${album.trackCount} 首</span>
    </article>
  `).join("");
  albumList.querySelectorAll(".album-card").forEach((card) => {
    card.addEventListener("click", () => selectAlbum(card.dataset.album));
  });
}

function renderTracks() {
  $("#albumName").textContent = state.album?.album || "未选择专辑";
  const trackList = $("#trackList");
  if (!state.album) {
    trackList.className = "track-list empty";
    trackList.textContent = "选择专辑后显示歌曲。";
    return;
  }
  trackList.className = "track-list";
  const filter = norm(state.filter);
  const songs = filter
    ? state.album.songs.filter((song) => norm(song).includes(filter))
    : state.album.songs;
  trackList.innerHTML = songs.map((song, index) => `
    <article class="track-row ${state.song === song ? "active" : ""}" data-song="${song}">
      <div class="track-no">${String(index + 1).padStart(2, "0")}</div>
      <div>
        <strong>${song}</strong>
        <span>${state.album.album}</span>
      </div>
    </article>
  `).join("");
  trackList.querySelectorAll(".track-row").forEach((row) => {
    row.addEventListener("click", () => selectSong(row.dataset.song));
  });
}

function renderDownloadPanel() {
  $("#selectedSong").textContent = state.song || "未选择歌曲";
  $("#searchSources").disabled = !state.profile || !state.album || !state.song;
  $("#downloadAlbum").disabled = !state.profile || !state.album;
}

function renderSources() {
  const list = $("#sourceList");
  if (!state.candidates.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.candidates.map((source, index) => `
    <article class="source-card">
      <strong>${source.title}</strong>
      <div class="source-meta">
        <span>${source.sourceType}</span>
        <span>${source.matchLevel || "candidate"}</span>
        ${source.aiLabel ? `<span>AI ${source.aiLabel}</span>` : ""}
        ${source.cached ? "<span>缓存</span>" : ""}
        <span>${Math.round(source.duration)} 秒</span>
        <span>评分 ${source.score}</span>
        <span>${source.uploader || "未知 UP"}</span>
      </div>
      ${source.aiReason ? `<div class="ai-reason">${source.aiReason}</div>` : ""}
      <div class="source-actions">
        <button class="preview-button" data-preview="${index}">${state.previewIndex === index ? "收起试听" : "试听"}</button>
        <button class="primary" data-index="${index}">下载这个源</button>
      </div>
      ${state.previewIndex === index ? renderPreview(source) : ""}
    </article>
  `).join("");
  list.querySelectorAll("[data-index]").forEach((button) => {
    button.addEventListener("click", () => downloadCandidate(Number(button.dataset.index)));
  });
  list.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.preview);
      state.previewIndex = state.previewIndex === index ? null : index;
      renderSources();
    });
  });
}

function renderPreview(source) {
  const index = state.candidates.indexOf(source);
  if (!source.bvid) {
    return `<div class="preview-fallback"><a href="${source.url}" target="_blank" rel="noreferrer">打开 B 站试听</a></div>`;
  }
  const src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(source.bvid)}&autoplay=0`;
  return `
    <div class="preview-frame">
      <iframe src="${src}" allowfullscreen="true" scrolling="no" referrerpolicy="no-referrer"></iframe>
    </div>
  `;
}

async function loadArtists() {
  state.artists = await api("/api/artists");
  renderArtists();
}

async function loadConfig() {
  state.config = await api("/api/config");
  $("#downloadRoot").value = state.config.downloadRoot || "";
  $("#llmEnabled").checked = Boolean(state.config.llm?.enabled);
  $("#llmBaseUrl").value = state.config.llm?.baseUrl || "";
  $("#llmModel").value = state.config.llm?.model || "";
  $("#llmState").textContent = state.config.llm?.enabled
    ? `已启用 · ${state.config.llm.model}${state.config.llm.hasApiKey ? "" : " · 未配置 API Key"}`
    : "默认关闭，不配置也可正常使用。";
}

async function savePath() {
  const downloadRoot = $("#downloadRoot").value.trim();
  if (!downloadRoot) {
    setStatus("下载目录不能为空。");
    return;
  }
  state.config = await api("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ downloadRoot })
  });
  $("#downloadRoot").value = state.config.downloadRoot;
  setStatus(`下载目录已保存：${state.config.downloadRoot}`);
}

async function saveLlm() {
  const payload = {
    llm: {
      enabled: $("#llmEnabled").checked,
      baseUrl: $("#llmBaseUrl").value.trim(),
      model: $("#llmModel").value.trim()
    }
  };
  const apiKey = $("#llmApiKey").value.trim();
  if (apiKey) payload.llm.apiKey = apiKey;
  state.config = await api("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  $("#llmApiKey").value = "";
  $("#llmState").textContent = state.config.llm.enabled
    ? `已启用 · ${state.config.llm.model}${state.config.llm.hasApiKey ? "" : " · 未配置 API Key"}`
    : "已关闭，大模型不会参与流程。";
  setStatus("大模型设置已保存。");
}

async function loadProfile(artist) {
  setStatus("正在载入本地曲库。");
  state.profile = await api(`/api/profile?artist=${encodeURIComponent(artist)}`);
  state.album = null;
  state.song = null;
  state.candidates = [];
  state.previewIndex = null;
  state.onlineArtists = [];
  state.onlineSongs = [];
  $("#artistInput").value = state.profile.name;
  state.query = "";
  renderSearchResults();
  renderOnlineResults();
  renderProfile();
  renderTracks();
  renderDownloadPanel();
  renderSources();
  setStatus("请选择专辑和歌曲。");
}

function selectAlbum(albumName) {
  state.album = state.profile.albums.find((album) => album.album === albumName);
  state.song = null;
  state.candidates = [];
  state.previewIndex = null;
  renderProfile();
  renderTracks();
  renderDownloadPanel();
  renderSources();
  setStatus("请选择歌曲。");
}

function selectSong(song) {
  state.song = song;
  state.candidates = [];
  state.previewIndex = null;
  renderTracks();
  renderDownloadPanel();
  renderSources();
  setStatus("可以搜索候选源。");
}

async function searchSources() {
  if (!state.song) return;
  setStatus("正在搜索 B 站候选源。");
  $("#searchSources").disabled = true;
  let reviewNote = "";
  try {
    state.previewIndex = null;
    state.candidates = await api(`/api/search?artist=${encodeURIComponent(state.profile.name)}&album=${encodeURIComponent(state.album.album)}&song=${encodeURIComponent(state.song)}&limit=5`);
    if (state.config?.llm?.enabled && state.candidates.length) {
      setStatus("正在用大模型评审候选源。");
      try {
        const reviewed = await api("/api/llm-review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            artist: state.profile.name,
            album: state.album.album,
            song: state.song,
            candidates: state.candidates
          })
        });
        if (reviewed.enabled) {
          state.candidates = reviewed.candidates;
          reviewNote = reviewed.reviewedCount
            ? `大模型已复核 ${reviewed.reviewedCount} 个候选源，请选择下载源。`
            : (reviewed.reason || "大模型未返回可用评分，已保留规则排序。");
        }
        else if (reviewed.reason) setStatus(reviewed.reason);
      } catch (error) {
        reviewNote = `大模型评审失败，已保留规则排序：${error.message}`;
      }
    }
    renderSources();
    setStatus(state.candidates.length ? (reviewNote || "请选择一个候选源下载。") : "没有找到可信候选源。");
  } catch (error) {
    setStatus(error.message);
  } finally {
    renderDownloadPanel();
  }
}

async function runLibrarySearch() {
  state.query = $("#artistInput").value.trim();
  state.onlineArtists = [];
  state.onlineSongs = [];
  renderOnlineResults();
  $("#onlineSearch").disabled = !state.query;
  renderArtists();
  if (!state.query) {
    renderSearchResults();
    return;
  }
  setStatus("正在搜索本地曲库。");
  try {
    const results = await api(`/api/library-search?q=${encodeURIComponent(state.query)}`);
    renderSearchResults(results);
    const exactSongHit = results.some((item) => item.type === "song" && norm(item.song) === norm(state.query));
    if (results.length === 1 && results[0].type === "artist") {
      await loadProfile(results[0].artist);
    } else {
      setStatus(results.length ? "选择一个本地搜索结果，或查看在线歌曲结果。" : "本地曲库没有匹配项，正在尝试在线歌曲搜索。");
      if (!exactSongHit) await runOnlineSearch();
    }
  } catch (error) {
    setStatus(error.message);
  }
}

async function runOnlineSearch() {
  state.query = $("#artistInput").value.trim();
  if (!state.query) return;
  setStatus("正在在线搜索歌曲和歌手。");
  $("#onlineSearch").disabled = true;
  try {
    const [artists, songs] = await Promise.all([
      api(`/api/online-artists?q=${encodeURIComponent(state.query)}`),
      api(`/api/online-recordings?q=${encodeURIComponent(state.query)}`)
    ]);
    state.onlineArtists = artists;
    state.onlineSongs = addInferredSongs(state.query, artists, songs);
    renderOnlineResults();
    setStatus((state.onlineArtists.length || state.onlineSongs.length) ? "选择在线结果建立本地曲库。" : "在线没有找到结果。");
  } catch (error) {
    setStatus(error.message);
  } finally {
    $("#onlineSearch").disabled = !state.query;
  }
}

async function buildLibrary(index) {
  const artist = state.onlineArtists[index];
  if (!artist) return;
  setStatus(`正在为 ${artist.name} 建立本地曲库。`);
  setProgress(1, "准备建库");
  try {
    const job = await api("/api/build-library-job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artistId: artist.id, artistName: artist.name })
    });
    await pollJob(job.id, async (result) => {
      await loadArtists();
      await loadProfile(result.name);
      setStatus(`建库完成：${result.albumCount} 张专辑，${result.songCount} 首歌。`);
      setProgress(100, `建库完成：${result.tracklistPath}`);
    });
  } catch (error) {
    setStatus(error.message);
    setProgress(0, "建库失败");
  }
}

async function buildLibraryFromSong(index) {
  const song = state.onlineSongs[index];
  if (!song) return;
  state.pendingLocate = { artist: song.displayArtistName, album: song.displayAlbum, song: song.displaySong };
  setStatus(`正在为 ${song.displayArtistName} 建库，完成后定位到 ${song.displaySong}。`);
  setProgress(1, "准备建库");
  try {
    const job = await api("/api/build-recording-library-job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artistId: song.artistId,
        artistName: song.artistName,
        album: song.album || song.displayAlbum || song.song,
        song: song.song || song.displaySong,
        skipFullBuild: Boolean(song.inferred)
      })
    });
    await pollJob(job.id, async (result) => {
      await loadArtists();
      await loadProfile(result.name);
      const found = await locateAndSearch(result.album || song.displayAlbum, result.song || song.displaySong);
      if (found) {
        setStatus(`已定位到 ${result.song || song.displaySong}，请选择候选源试听或下载。`);
      } else {
        setStatus(`已建库，但没有在本地库中定位到 ${song.displaySong}。请重新搜索或手动选择。`);
      }
    });
  } catch (error) {
    setStatus(error.message);
    setProgress(0, "建库失败");
  }
}

async function locateAndSearch(albumName, songName) {
  const targetAlbum = state.profile.albums.find((album) => norm(album.album) === norm(albumName)) ||
    state.profile.albums.find((album) => album.songs.some((song) => norm(song) === norm(songName)));
  if (!targetAlbum) return false;
  selectAlbum(targetAlbum.album);
  const targetSong = targetAlbum.songs.find((song) => norm(song) === norm(songName)) || targetAlbum.songs[0];
  if (!targetSong) return false;
  selectSong(targetSong);
  await searchSources();
  return true;
}

async function downloadAlbum() {
  openAlbumPage();
}

async function downloadCandidate(index) {
  if (!$("#rightsCheck").checked) {
    setStatus("请先确认你有权下载所选内容。");
    return;
  }
  const source = state.candidates[index];
  setStatus("正在下载并转换为 MP3。");
  setProgress(1, "准备下载");
  try {
    const job = await api("/api/download-job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artist: state.profile.name,
        album: state.album.album,
        song: state.song,
        url: source.url,
        iHaveRights: true
      })
    });
    await pollJob(job.id, async (result) => {
      setStatus(result.status === "downloaded" ? `下载完成：${result.savedPath}` : "下载命令已执行，但没有找到输出文件。");
      setProgress(100, result.savedPath || "下载结束");
    });
  } catch (error) {
    setStatus(error.message);
    setProgress(0, "下载失败");
  }
}

$("#loadArtist").addEventListener("click", () => {
  runLibrarySearch();
});

$("#artistInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runLibrarySearch();
  }
});

$("#artistInput").addEventListener("input", () => {
  state.query = $("#artistInput").value.trim();
  $("#onlineSearch").disabled = !state.query;
  renderArtists();
});

$("#libraryFilter").addEventListener("input", () => {
  state.filter = $("#libraryFilter").value.trim();
  renderProfile();
  renderTracks();
});

$("#searchSources").addEventListener("click", searchSources);
$("#onlineSearch").addEventListener("click", runOnlineSearch);
$("#savePath").addEventListener("click", savePath);
$("#saveLlm").addEventListener("click", () => saveLlm().catch((error) => setStatus(error.message)));
$("#downloadAlbum").addEventListener("click", downloadAlbum);

await loadConfig();
await loadArtists();
if (state.artists[0]) {
  await loadProfile(state.artists[0].name);
}
