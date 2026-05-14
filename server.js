import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as OpenCC from "opencc-js";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4587);
const HOST = process.env.HOST || "127.0.0.1";
const MUSIC_ROOT = process.env.MUSIC_ROOT || path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const USER_AGENT = "MusicDownloaderApp/0.1 (local)";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const YT_DLP_BROWSER_HEADERS = [
  "--add-header",
  `User-Agent:${BROWSER_USER_AGENT}`,
  "--add-header",
  "Referer:https://www.bilibili.com"
];
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "music.db");
const PREVIEW_DIR = process.env.PREVIEW_DIR || path.join(__dirname, "preview-cache");
const jobs = new Map();
const db = new DatabaseSync(DB_PATH);
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, value) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(value);
}

function sanitizeSegment(value) {
  return String(value || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

function normalizeSearch(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function applyKnownTitleAliases(value) {
  return String(value || "")
    .replace(/达拉蹦吧/g, "达拉崩吧")
    .replace(/達拉蹦吧/g, "达拉崩吧")
    .replace(/達拉崩吧/g, "达拉崩吧");
}

function normalizeTitleBase(value) {
  return normalizeSearch(applyKnownTitleAliases(value)
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/\blive\b/gi, " "));
}

function simplifyText(value) {
  return applyKnownTitleAliases(toSimplified(String(value || "")));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      norm_name TEXT NOT NULL,
      search_name TEXT,
      norm_search_name TEXT,
      mbid TEXT,
      sort_name TEXT,
      country TEXT,
      type TEXT,
      disambiguation TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      norm_title TEXT NOT NULL,
      search_title TEXT,
      norm_search_title TEXT,
      release_date TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(artist_id, title)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      norm_title TEXT NOT NULL,
      search_title TEXT,
      norm_search_title TEXT,
      track_no INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(album_id, title)
    );

    CREATE TABLE IF NOT EXISTS bilibili_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      uploader TEXT,
      bvid TEXT,
      url TEXT NOT NULL,
      duration REAL,
      view_count INTEGER,
      source_type TEXT,
      score INTEGER,
      match_level TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(track_id, url)
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      candidate_id INTEGER REFERENCES bilibili_candidates(id),
      saved_path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

  `);
  migrateDb();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_artists_norm ON artists(norm_name);
    CREATE INDEX IF NOT EXISTS idx_artists_search ON artists(norm_search_name);
    CREATE INDEX IF NOT EXISTS idx_albums_artist_norm ON albums(artist_id, norm_title);
    CREATE INDEX IF NOT EXISTS idx_albums_artist_search ON albums(artist_id, norm_search_title);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_norm ON tracks(album_id, norm_title);
    CREATE INDEX IF NOT EXISTS idx_tracks_album_search ON tracks(album_id, norm_search_title);
    CREATE INDEX IF NOT EXISTS idx_candidates_track ON bilibili_candidates(track_id, created_at);
  `);
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateDb() {
  ensureColumn("artists", "search_name", "TEXT");
  ensureColumn("artists", "norm_search_name", "TEXT");
  ensureColumn("albums", "search_title", "TEXT");
  ensureColumn("albums", "norm_search_title", "TEXT");
  ensureColumn("tracks", "search_title", "TEXT");
  ensureColumn("tracks", "norm_search_title", "TEXT");
  for (const artist of db.prepare("SELECT id, name FROM artists WHERE search_name IS NULL OR search_name = ''").all()) {
    const searchName = simplifyText(artist.name);
    db.prepare("UPDATE artists SET search_name = ?, norm_search_name = ? WHERE id = ?")
      .run(searchName, normalizeSearch(searchName), artist.id);
  }
  for (const album of db.prepare("SELECT id, title FROM albums WHERE search_title IS NULL OR search_title = ''").all()) {
    const searchTitle = simplifyText(album.title);
    db.prepare("UPDATE albums SET search_title = ?, norm_search_title = ? WHERE id = ?")
      .run(searchTitle, normalizeSearch(searchTitle), album.id);
  }
  for (const track of db.prepare("SELECT id, title FROM tracks WHERE search_title IS NULL OR search_title = ''").all()) {
    const searchTitle = simplifyText(track.title);
    db.prepare("UPDATE tracks SET search_title = ?, norm_search_title = ? WHERE id = ?")
      .run(searchTitle, normalizeSearch(searchTitle), track.id);
  }
}

function upsertArtist(name, meta = {}) {
  const existing = db.prepare("SELECT id FROM artists WHERE name = ?").get(name);
  const searchName = simplifyText(name);
  if (existing) {
    db.prepare(`
      UPDATE artists
      SET norm_name = ?, search_name = ?, norm_search_name = ?,
          mbid = COALESCE(?, mbid), sort_name = COALESCE(?, sort_name),
          country = COALESCE(?, country), type = COALESCE(?, type),
          disambiguation = COALESCE(?, disambiguation), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(normalizeSearch(name), searchName, normalizeSearch(searchName), meta.mbid || null, meta.sortName || null, meta.country || null, meta.type || null, meta.disambiguation || null, existing.id);
    return existing.id;
  }
  const result = db.prepare(`
    INSERT INTO artists (name, norm_name, search_name, norm_search_name, mbid, sort_name, country, type, disambiguation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, normalizeSearch(name), searchName, normalizeSearch(searchName), meta.mbid || null, meta.sortName || null, meta.country || null, meta.type || null, meta.disambiguation || null);
  return Number(result.lastInsertRowid);
}

function replaceArtistLibrary(name, albums, meta = {}) {
  const artistId = upsertArtist(name, meta);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM albums WHERE artist_id = ?").run(artistId);
    const insertAlbum = db.prepare(`
      INSERT INTO albums (artist_id, title, norm_title, search_title, norm_search_title, release_date, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTrack = db.prepare(`
      INSERT INTO tracks (album_id, title, norm_title, search_title, norm_search_title, track_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    albums.forEach((album, albumIndex) => {
      const albumSearchTitle = simplifyText(album.album);
      const albumResult = insertAlbum.run(artistId, album.album, normalizeSearch(album.album), albumSearchTitle, normalizeSearch(albumSearchTitle), album.date || "", albumIndex + 1);
      const albumId = Number(albumResult.lastInsertRowid);
      album.songs.forEach((song, trackIndex) => {
        const trackSearchTitle = simplifyText(song);
        insertTrack.run(albumId, song, normalizeSearch(song), trackSearchTitle, normalizeSearch(trackSearchTitle), trackIndex + 1);
      });
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return artistId;
}

function findArtistId(name) {
  const searchName = simplifyText(name);
  const row = db.prepare(`
    SELECT id FROM artists
    WHERE name = ? OR norm_name = ? OR norm_search_name = ?
    LIMIT 1
  `).get(name, normalizeSearch(name), normalizeSearch(searchName));
  return row ? Number(row.id) : 0;
}

function ensureRecordingTrack({ artistId, artistName, album, song }) {
  if (!artistName || !song) throw new Error("artistName and song are required.");
  const albumTitle = album || song;
  const dbArtistId = upsertArtist(artistName, { mbid: artistId });
  const albumSearchTitle = simplifyText(albumTitle);
  const songSearchTitle = simplifyText(song);

  let albumRow = db.prepare(`
    SELECT id FROM albums
    WHERE artist_id = ? AND (norm_title = ? OR norm_search_title = ?)
    LIMIT 1
  `).get(dbArtistId, normalizeSearch(albumTitle), normalizeSearch(albumSearchTitle));

  if (!albumRow) {
    const nextPosition = Number(db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM albums WHERE artist_id = ?")
      .get(dbArtistId).position || 1);
    const result = db.prepare(`
      INSERT INTO albums (artist_id, title, norm_title, search_title, norm_search_title, release_date, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(dbArtistId, albumTitle, normalizeSearch(albumTitle), albumSearchTitle, normalizeSearch(albumSearchTitle), "", nextPosition);
    albumRow = { id: Number(result.lastInsertRowid) };
  }

  const trackRow = db.prepare(`
    SELECT id FROM tracks
    WHERE album_id = ? AND (norm_title = ? OR norm_search_title = ?)
    LIMIT 1
  `).get(albumRow.id, normalizeSearch(song), normalizeSearch(songSearchTitle));

  if (!trackRow) {
    const nextTrackNo = Number(db.prepare("SELECT COALESCE(MAX(track_no), 0) + 1 AS track_no FROM tracks WHERE album_id = ?")
      .get(albumRow.id).track_no || 1);
    db.prepare(`
      INSERT INTO tracks (album_id, title, norm_title, search_title, norm_search_title, track_no)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(albumRow.id, song, normalizeSearch(song), songSearchTitle, normalizeSearch(songSearchTitle), nextTrackNo);
  }

  return {
    artistId: dbArtistId,
    name: artistName,
    displayName: simplifyText(artistName),
    album: albumTitle,
    displayAlbum: albumSearchTitle,
    song,
    displaySong: songSearchTitle
  };
}

function rowsToAlbums(rows) {
  const albumsByName = new Map();
  for (const row of rows) {
    if (!albumsByName.has(row.album)) albumsByName.set(row.album, []);
    albumsByName.get(row.album).push(row.song);
  }
  return [...albumsByName.entries()].map(([album, songs]) => ({ album, songs }));
}

async function importCsvTracklistToDb(artistName) {
  const artistDir = path.join(MUSIC_ROOT, sanitizeSegment(artistName));
  const tracklistPath = path.join(artistDir, "tracklist.csv");
  const text = await fs.readFile(tracklistPath, "utf8");
  const rows = parseCsv(text).filter((row) => row.album && row.song);
  replaceArtistLibrary(artistName, rowsToAlbums(rows));
  return rows.length;
}

async function seedDbFromTracklists() {
  const entries = await fs.readdir(MUSIC_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "music-downloader-app") continue;
    const tracklistPath = path.join(MUSIC_ROOT, entry.name, "tracklist.csv");
    try {
      await fs.access(tracklistPath);
      const existing = db.prepare("SELECT id FROM artists WHERE name = ?").get(entry.name);
      if (!existing) await importCsvTracklistToDb(entry.name);
    } catch {
      // Ignore directories without a compatible tracklist.
    }
  }
}

async function loadConfig() {
  try {
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    return {
      libraryRoot: saved.libraryRoot || MUSIC_ROOT,
      downloadRoot: saved.downloadRoot || MUSIC_ROOT,
      llm: {
        enabled: Boolean(saved.llm?.enabled),
        baseUrl: saved.llm?.baseUrl || "https://api.openai.com/v1",
        model: saved.llm?.model || "gpt-4o-mini",
        apiKey: saved.llm?.apiKey || ""
      }
    };
  } catch {
    return {
      libraryRoot: MUSIC_ROOT,
      downloadRoot: MUSIC_ROOT,
      llm: {
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: ""
      }
    };
  }
}

async function saveConfig(next) {
  const current = await loadConfig();
  const config = {
    libraryRoot: next.libraryRoot || current.libraryRoot,
    downloadRoot: next.downloadRoot || current.downloadRoot,
    llm: {
      enabled: typeof next.llm?.enabled === "boolean" ? next.llm.enabled : current.llm.enabled,
      baseUrl: next.llm?.baseUrl || current.llm.baseUrl,
      model: next.llm?.model || current.llm.model,
      apiKey: Object.prototype.hasOwnProperty.call(next.llm || {}, "apiKey") ? next.llm.apiKey : current.llm.apiKey
    }
  };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  return config;
}

function createJob(label) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    label,
    status: "running",
    progress: 0,
    message: "Queued",
    logs: [],
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  jobs.set(id, job);
  return job;
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (patch.message) job.logs.push(patch.message);
  if (job.logs.length > 80) job.logs = job.logs.slice(-80);
  return job;
}

function finishJob(job, result) {
  updateJob(job, { status: "done", progress: 100, message: "Done", result });
}

function failJob(job, error) {
  updateJob(job, { status: "error", message: error.message || String(error), error: error.message || String(error) });
}

function publicConfig(config) {
  return {
    libraryRoot: config.libraryRoot,
    downloadRoot: config.downloadRoot,
    llm: {
      enabled: config.llm.enabled,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      hasApiKey: Boolean(config.llm.apiKey)
    }
  };
}

function splitCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((x) => x.trim());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

async function readTracklist(artist) {
  const artistRow = db.prepare("SELECT id, name FROM artists WHERE norm_name = ? OR name = ? LIMIT 1")
    .get(normalizeSearch(artist), artist);
  if (artistRow) {
    return db.prepare(`
      SELECT albums.title AS album, tracks.title AS song, tracks.track_no AS trackNo
      FROM tracks
      JOIN albums ON albums.id = tracks.album_id
      WHERE albums.artist_id = ?
      ORDER BY albums.position, albums.id, tracks.track_no, tracks.id
    `).all(artistRow.id);
  }
  await importCsvTracklistToDb(artist);
  return readTracklist(artist);
}

async function listArtists() {
  return db.prepare(`
    SELECT artists.search_name AS name,
           artists.name AS rawName,
           COUNT(DISTINCT albums.id) AS albumCount,
           COUNT(tracks.id) AS songCount
    FROM artists
    LEFT JOIN albums ON albums.artist_id = artists.id
    LEFT JOIN tracks ON tracks.album_id = albums.id
    GROUP BY artists.id
    ORDER BY artists.search_name COLLATE NOCASE
  `).all();
}

async function searchLibrary(query) {
  const q = normalizeSearch(query);
  if (!q) return [];
  const results = [];
  const like = `%${q}%`;
  for (const row of db.prepare(`
    SELECT artists.search_name AS artist, artists.name AS rawArtist, COUNT(DISTINCT albums.id) AS albumCount, COUNT(tracks.id) AS songCount
    FROM artists
    LEFT JOIN albums ON albums.artist_id = artists.id
    LEFT JOIN tracks ON tracks.album_id = albums.id
    WHERE artists.norm_name LIKE ? OR artists.norm_search_name LIKE ?
    GROUP BY artists.id
    LIMIT 15
  `).all(like, like)) {
    results.push({ type: "artist", artist: row.artist, rawArtist: row.rawArtist, album: "", song: "", label: row.artist, detail: `${row.albumCount} albums / ${row.songCount} songs` });
  }
  for (const row of db.prepare(`
    SELECT artists.search_name AS artist, artists.name AS rawArtist, albums.search_title AS album, albums.title AS rawAlbum, COUNT(tracks.id) AS trackCount
    FROM albums
    JOIN artists ON artists.id = albums.artist_id
    LEFT JOIN tracks ON tracks.album_id = albums.id
    WHERE albums.norm_title LIKE ? OR albums.norm_search_title LIKE ?
    GROUP BY albums.id
    LIMIT 20
  `).all(like, like)) {
    results.push({ type: "album", artist: row.artist, rawArtist: row.rawArtist, album: row.album, rawAlbum: row.rawAlbum, song: "", label: row.album, detail: `${row.artist} / ${row.trackCount} songs` });
  }
  for (const row of db.prepare(`
    SELECT artists.search_name AS artist, artists.name AS rawArtist, albums.search_title AS album, albums.title AS rawAlbum, tracks.search_title AS song, tracks.title AS rawSong
    FROM tracks
    JOIN albums ON albums.id = tracks.album_id
    JOIN artists ON artists.id = albums.artist_id
    WHERE tracks.norm_title LIKE ? OR tracks.norm_search_title LIKE ?
    ORDER BY artists.name, albums.position, tracks.track_no
    LIMIT 30
  `).all(like, like)) {
    results.push({ type: "song", artist: row.artist, rawArtist: row.rawArtist, album: row.album, rawAlbum: row.rawAlbum, song: row.song, rawSong: row.rawSong, label: row.song, detail: `${row.artist} / ${row.album}` });
  }
  return results.slice(0, 50);
}

async function musicBrainzGet(pathname, params = {}) {
  const url = new URL(`https://musicbrainz.org/ws/2/${pathname}`);
  url.searchParams.set("fmt", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept": "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`MusicBrainz request failed: ${response.status}`);
  }
  return response.json();
}

async function searchOnlineArtists(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const data = await musicBrainzGet("artist", { query: q, limit: 10 });
  return (data.artists || []).map((artist) => ({
    id: artist.id,
    name: artist.name,
    sortName: artist["sort-name"] || "",
    country: artist.country || "",
    type: artist.type || "",
    disambiguation: artist.disambiguation || "",
    score: Number(artist.score || 0)
  })).filter((artist) => artist.id && artist.name);
}

async function searchOnlineRecordings(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const data = await musicBrainzGet("recording", { query: q, limit: 12 });
  const qNorm = normalizeSearch(q);
  const qParts = q.split(/\s+/).map((part) => normalizeSearch(part)).filter(Boolean);
  const results = [];
  for (const recording of data.recordings || []) {
    const artistCredit = recording["artist-credit"] || [];
    const artist = artistCredit.find((credit) => credit.artist?.id)?.artist;
    if (!artist?.id) continue;
    const release = (recording.releases || []).find((item) => item.title) || {};
    results.push({
      type: "recording",
      artistId: artist.id,
      artistName: artist.name,
      displayArtistName: simplifyText(artist.name),
      song: recording.title,
      displaySong: simplifyText(recording.title),
      album: release.title || "",
      displayAlbum: simplifyText(release.title || ""),
      country: artist.country || "",
      disambiguation: recording.disambiguation || artist.disambiguation || "",
      score: Number(recording.score || 0)
    });
  }
  const seen = new Set();
  return results.filter((item) => {
    const key = `${item.artistId}|${normalizeSearch(item.song)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => {
    const rank = (item) => {
      const artistNorm = normalizeSearch(item.displayArtistName);
      const songNorm = normalizeSearch(item.displaySong);
      const songBaseNorm = normalizeTitleBase(item.displaySong);
      let value = Number(item.score || 0);
      const artistHit = artistNorm && (qNorm.includes(artistNorm) || qParts.includes(artistNorm));
      const songHit = songBaseNorm && (
        qNorm.includes(songBaseNorm) ||
        qParts.includes(songBaseNorm) ||
        qParts.some((part) => songBaseNorm.includes(part) || part.includes(songBaseNorm))
      );
      if (songHit) value += 350;
      if (artistHit) value += 260;
      if (artistHit && songHit) value += 240;
      if (songNorm && qNorm.includes(songNorm)) value += 80;
      if (songBaseNorm && qNorm.endsWith(songBaseNorm)) value += 50;
      return value;
    };
    return rank(b) - rank(a);
  });
}

function chooseRelease(releases) {
  const official = releases.filter((release) => release.status === "Official");
  const pool = official.length ? official : releases;
  return [...pool].sort((a, b) => {
    const aTracks = Number(a["track-count"] || 0);
    const bTracks = Number(b["track-count"] || 0);
    if (bTracks !== aTracks) return bTracks - aTracks;
    return String(a.date || "").localeCompare(String(b.date || ""));
  })[0];
}

async function getReleaseTracks(releaseId) {
  const data = await musicBrainzGet(`release/${releaseId}`, { inc: "recordings" });
  const tracks = [];
  for (const medium of data.media || []) {
    for (const track of medium.tracks || []) {
      const title = track.title || track.recording?.title;
      if (title) tracks.push(title);
    }
  }
  return [...new Set(tracks)];
}

async function buildOnlineLibrary({ artistId, artistName }, onProgress = () => {}) {
  if (!artistId || !artistName) throw new Error("artistId and artistName are required.");
  onProgress({ progress: 2, message: `Searching albums for ${artistName}` });
  const groups = await musicBrainzGet("release-group", {
    artist: artistId,
    type: "album",
    limit: 40
  });
  const releaseGroups = (groups["release-groups"] || [])
    .filter((group) => group["primary-type"] === "Album")
    .filter((group) => !group["secondary-types"] || group["secondary-types"].length === 0)
    .sort((a, b) => String(a["first-release-date"] || "").localeCompare(String(b["first-release-date"] || "")));

  const albums = [];
  for (let index = 0; index < releaseGroups.length; index += 1) {
    const group = releaseGroups[index];
    const baseProgress = 5 + Math.round((index / Math.max(1, releaseGroups.length)) * 80);
    onProgress({ progress: baseProgress, message: `Reading album: ${group.title}` });
    await sleep(1100);
    const releasesData = await musicBrainzGet("release", {
      "release-group": group.id,
      status: "official",
      limit: 10
    });
    const release = chooseRelease(releasesData.releases || []);
    if (!release?.id) continue;
    await sleep(1100);
    onProgress({ progress: Math.min(90, baseProgress + 3), message: `Reading tracks: ${group.title}` });
    const tracks = await getReleaseTracks(release.id);
    if (!tracks.length) continue;
    albums.push({
      album: group.title,
      date: group["first-release-date"] || release.date || "",
      trackCount: tracks.length,
      songs: tracks
    });
  }

  if (!albums.length) {
    throw new Error("No album tracklist found from MusicBrainz.");
  }

  const artistDir = path.join(MUSIC_ROOT, sanitizeSegment(artistName));
  onProgress({ progress: 92, message: `Writing tracklist: ${artistDir}` });
  await fs.mkdir(artistDir, { recursive: true });
  const rows = ["album,song"];
  for (const album of albums) {
    for (const song of album.songs) {
      rows.push(`${csvEscape(album.album)},${csvEscape(song)}`);
    }
  }
  const tracklistPath = path.join(artistDir, "tracklist.csv");
  await fs.writeFile(tracklistPath, `${rows.join("\n")}\n`, "utf8");
  replaceArtistLibrary(artistName, albums, { mbid: artistId });

  const songCount = albums.reduce((sum, album) => sum + album.songs.length, 0);
  return {
    name: artistName,
    source: "MusicBrainz",
    outputRoot: artistDir,
    tracklistPath,
    albumCount: albums.length,
    songCount,
    albums
  };
}

async function buildRecordingLibrary({ artistId, artistName, album, song, skipFullBuild = false }, onProgress = () => {}) {
  if (!artistId || !artistName || !song) throw new Error("artistId, artistName and song are required.");
  onProgress({ progress: 2, message: `准备定位歌曲: ${song}` });

  if (!skipFullBuild && !findArtistId(artistName)) {
    try {
      await buildOnlineLibrary({ artistId, artistName }, onProgress);
    } catch (error) {
      onProgress({ progress: 45, message: `专辑库不完整，先补入单曲: ${song}` });
    }
  } else if (skipFullBuild) {
    onProgress({ progress: 45, message: `直接补入单曲: ${song}` });
  }

  const ensured = ensureRecordingTrack({ artistId, artistName, album, song });
  const profile = await getProfile(artistName);
  onProgress({ progress: 100, message: `已写入并定位: ${ensured.displaySong}` });
  return {
    name: ensured.name,
    displayName: ensured.displayName,
    album: ensured.displayAlbum,
    song: ensured.displaySong,
    albumCount: profile.albumCount,
    songCount: profile.songCount
  };
}

async function getProfile(artist) {
  const artistRow = db.prepare("SELECT id, name, search_name FROM artists WHERE norm_name = ? OR norm_search_name = ? OR name = ? LIMIT 1")
    .get(normalizeSearch(artist), normalizeSearch(artist), artist);
  if (!artistRow) {
    await importCsvTracklistToDb(artist);
    return getProfile(artist);
  }
  const albumRows = db.prepare(`
    SELECT id, title AS rawAlbum, search_title AS album
    FROM albums
    WHERE artist_id = ?
    ORDER BY position, id
  `).all(artistRow.id);
  const trackStmt = db.prepare(`
    SELECT title AS rawTitle, search_title AS title
    FROM tracks
    WHERE album_id = ?
    ORDER BY track_no, id
  `);
  const albums = albumRows.map((album) => {
    const songs = trackStmt.all(album.id).map((track) => track.title);
    return { album: album.album, rawAlbum: album.rawAlbum, trackCount: songs.length, songs };
  });
  return {
    name: artistRow.search_name || simplifyText(artistRow.name),
    rawName: artistRow.name,
    outputRoot: path.join(MUSIC_ROOT, sanitizeSegment(artistRow.name)),
    albumCount: albums.length,
    songCount: albums.reduce((sum, album) => sum + album.trackCount, 0),
    albums
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: MUSIC_ROOT,
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

function runCommandStreaming(command, args, onData, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: MUSIC_ROOT,
      windowsHide: true,
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onData(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onData(text);
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error) }));
  });
}

function firstJsonLine(text) {
  return text.split(/\r?\n/).find((line) => /^\s*[\[{]/.test(line));
}

async function ytDlpJson(args) {
  const result = await runCommand("yt-dlp", [...YT_DLP_BROWSER_HEADERS, ...args]);
  const jsonLine = firstJsonLine(result.stdout || result.stderr);
  if (!jsonLine) return null;
  return JSON.parse(jsonLine);
}

async function getPreviewUrl(videoUrl) {
  if (!videoUrl) throw new Error("url is required.");
  const result = await runCommand("yt-dlp", [...YT_DLP_BROWSER_HEADERS, "-f", "ba", "-g", "--no-playlist", videoUrl]);
  const directUrl = (result.stdout || result.stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("http"));
  if (!directUrl) throw new Error("No preview audio URL found.");
  return { url: directUrl };
}

async function getPreviewFile(videoUrl) {
  if (!videoUrl) throw new Error("url is required.");
  await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const id = crypto.createHash("sha1").update(videoUrl).digest("hex");
  const mp3Path = path.join(PREVIEW_DIR, `${id}.mp3`);
  try {
    await fs.access(mp3Path);
    return { url: `/preview-cache/${id}.mp3`, cached: true };
  } catch {
    // Create below.
  }

  const template = path.join(PREVIEW_DIR, `${id}.%(ext)s`);
  const result = await runCommand("yt-dlp", [
    ...YT_DLP_BROWSER_HEADERS,
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--force-overwrites",
    "-o",
    template,
    videoUrl
  ]);
  try {
    await fs.access(mp3Path);
  } catch {
    throw new Error((result.stderr || result.stdout || "Preview conversion failed.").slice(-500));
  }
  return { url: `/preview-cache/${id}.mp3`, cached: false };
}

function isBadCandidate(text) {
  const lower = text.toLowerCase();
  return [
    "cover",
    "reaction",
    "ai cover",
    "tutorial",
    "ranking",
    "ranked",
    "commentary",
    "karaoke",
    "instrumental",
    "guitar tab",
    "backing track",
    "lesson",
    "toys",
    "drum score",
    "伴奏",
    "纯伴奏",
    "吉他谱",
    "教学",
    "翻唱",
    "玩具",
    "鼓谱",
    "动态鼓谱"
  ].some((pattern) => lower.includes(pattern.toLowerCase()));
}

function isWeakCandidate(title) {
  const lower = title.toLowerCase();
  return title.includes("含义") ||
    title.includes("解读") ||
    title.includes("花絮") ||
    title.includes("采访") ||
    title.includes("直拍") ||
    lower.includes("reaction");
}

function sourceType(title) {
  const text = title.toLowerCase();
  if (text.includes("official") || title.includes("官方")) return "official";
  if (title.includes("4K") || text.includes("remaster") || title.includes("修复") || title.includes("无损") || text.includes("hi-res")) return "remaster";
  return "candidate";
}

function scoreCandidate({ artist, album, song, title, duration, viewCount }) {
  let score = 0;
  const titleLower = applyKnownTitleAliases(title).toLowerCase();
  const artistLower = applyKnownTitleAliases(artist).toLowerCase();
  const songLower = applyKnownTitleAliases(song).toLowerCase();
  const albumLower = applyKnownTitleAliases(album).toLowerCase();
  if (titleLower.includes(songLower)) score += 70;
  if (titleLower.includes(artistLower)) score += 20;
  if (album && titleLower.includes(albumLower)) score += 8;
  if (duration > 90 && duration < 600) score += 8;
  if (duration > 900) score -= 30;
  if (viewCount) score += Math.min(10, Math.floor(Math.log10(Number(viewCount) + 1)));
  if (title.includes("MV")) score += 6;
  if (title.includes("4K") || title.includes("修复") || title.toLowerCase().includes("hi-res")) score += 5;
  return score;
}

function findTrackId(artist, album, song) {
  const row = db.prepare(`
    SELECT tracks.id
    FROM tracks
    JOIN albums ON albums.id = tracks.album_id
    JOIN artists ON artists.id = albums.artist_id
    WHERE (artists.norm_name = ? OR artists.norm_search_name = ?)
      AND (albums.norm_title = ? OR albums.norm_search_title = ?)
      AND (tracks.norm_title = ? OR tracks.norm_search_title = ?)
    LIMIT 1
  `).get(
    normalizeSearch(artist), normalizeSearch(artist),
    normalizeSearch(album), normalizeSearch(album),
    normalizeSearch(song), normalizeSearch(song)
  );
  return row?.id || null;
}

function getSearchTermsForTrack(artist, album, song) {
  const row = db.prepare(`
    SELECT artists.search_name AS artistSearch, albums.search_title AS albumSearch, tracks.search_title AS songSearch
    FROM tracks
    JOIN albums ON albums.id = tracks.album_id
    JOIN artists ON artists.id = albums.artist_id
    WHERE (artists.norm_name = ? OR artists.norm_search_name = ?)
      AND (albums.norm_title = ? OR albums.norm_search_title = ?)
      AND (tracks.norm_title = ? OR tracks.norm_search_title = ?)
    LIMIT 1
  `).get(
    normalizeSearch(artist), normalizeSearch(artist),
    normalizeSearch(album), normalizeSearch(album),
    normalizeSearch(song), normalizeSearch(song)
  );
  return {
    artist: row?.artistSearch || simplifyText(artist),
    album: row?.albumSearch || simplifyText(album),
    song: row?.songSearch || simplifyText(song)
  };
}

function getCachedCandidates(trackId) {
  if (!trackId) return [];
  return db.prepare(`
    SELECT title, uploader, bvid, url, duration, view_count AS viewCount,
           source_type AS sourceType, score, match_level AS matchLevel
    FROM bilibili_candidates
    WHERE track_id = ?
      AND created_at >= datetime('now', '-7 days')
    ORDER BY score DESC, view_count DESC
    LIMIT 10
  `).all(trackId);
}

function saveCandidates(trackId, candidates) {
  if (!trackId || !candidates.length) return;
  const stmt = db.prepare(`
    INSERT INTO bilibili_candidates
      (track_id, title, uploader, bvid, url, duration, view_count, source_type, score, match_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_id, url) DO UPDATE SET
      title = excluded.title,
      uploader = excluded.uploader,
      bvid = excluded.bvid,
      duration = excluded.duration,
      view_count = excluded.view_count,
      source_type = excluded.source_type,
      score = excluded.score,
      match_level = excluded.match_level,
      created_at = CURRENT_TIMESTAMP
  `);
  db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      stmt.run(trackId, candidate.title, candidate.uploader, candidate.bvid, candidate.url, candidate.duration, candidate.viewCount, candidate.sourceType, candidate.score, candidate.matchLevel);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function searchCandidates({ artist, album, song, limit = 8 }) {
  const trackId = findTrackId(artist, album, song);
  const cached = getCachedCandidates(trackId);
  if (cached.length) return cached.map((candidate) => ({ ...candidate, cached: true }));

  const searchNames = getSearchTermsForTrack(artist, album, song);
  const terms = [
    `${searchNames.artist} ${searchNames.song} MV`,
    `${searchNames.artist} ${searchNames.song}`,
    `${searchNames.artist} ${searchNames.song} 4K`,
    `${artist} ${song} MV`
  ];
  const seen = new Set();
  const candidates = [];
  const fallback = [];

  for (const term of terms) {
    const search = await ytDlpJson(["--flat-playlist", "--dump-single-json", `bilisearch${limit}:${term}`]);
    for (const entry of search?.entries || []) {
      if (!entry) continue;
      if (!entry.url || seen.has(entry.url)) continue;
      seen.add(entry.url);
      const info = await ytDlpJson(["--dump-single-json", "--skip-download", entry.url]);
      if (!info?.title) continue;
      const text = `${info.title} ${info.description || ""} ${(info.tags || []).join(" ")}`;
      if (isBadCandidate(text)) continue;
      const titleNorm = normalizeSearch(applyKnownTitleAliases(info.title));
      const textNorm = normalizeSearch(applyKnownTitleAliases(text));
      const titleHasSong = titleNorm.includes(normalizeSearch(applyKnownTitleAliases(song))) || titleNorm.includes(normalizeSearch(applyKnownTitleAliases(searchNames.song)));
      const textHasArtist = textNorm.includes(normalizeSearch(artist)) || textNorm.includes(normalizeSearch(searchNames.artist));
      if (!titleHasSong && !textHasArtist) continue;
      if (Number(info.duration || 0) > 900 && (info.title.includes("专辑") || info.title.toLowerCase().includes("album"))) continue;
      const candidate = {
        title: info.title,
        uploader: info.uploader || "",
        bvid: info.id || "",
        url: entry.url,
        duration: Number(info.duration || 0),
        viewCount: Number(info.view_count || 0),
        sourceType: sourceType(info.title),
        score: 0,
        matchLevel: titleHasSong && textHasArtist ? "trusted" : "fallback"
      };
      candidate.score = scoreCandidate({ artist: searchNames.artist, album: searchNames.album, song: searchNames.song, ...candidate });
      if (isWeakCandidate(candidate.title)) candidate.score -= 35;
      if (candidate.matchLevel === "trusted" && candidate.score >= 60) candidates.push(candidate);
      else if (candidate.score >= 35) fallback.push(candidate);
    }
  }

  const trusted = candidates
    .sort((a, b) => b.score - a.score || b.viewCount - a.viewCount)
    .slice(0, 10);
  if (trusted.length) {
    saveCandidates(trackId, trusted);
    return trusted;
  }
  const fallbackResults = fallback
    .sort((a, b) => b.score - a.score || b.viewCount - a.viewCount)
    .slice(0, 10);
  saveCandidates(trackId, fallbackResults);
  return fallbackResults;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("LLM response was not valid JSON.");
  }
}

async function reviewCandidatesWithLlm({ artist, album, song, candidates }) {
  const config = await loadConfig();
  if (!config.llm.enabled) return { enabled: false, candidates };
  if (!config.llm.apiKey) return { enabled: false, reason: "LLM API key is not configured.", candidates };
  const safeCandidates = (candidates || []).slice(0, 10).map((candidate, index) => ({
    index,
    title: candidate.title,
    uploader: candidate.uploader,
    duration: candidate.duration,
    sourceType: candidate.sourceType,
    matchLevel: candidate.matchLevel,
    score: candidate.score,
    url: candidate.url
  }));
  const prompt = [
    "You are helping rank Bilibili music download candidates.",
    "Return only JSON. Do not include markdown.",
    "Task: judge which candidates are most likely to be the requested original song or acceptable official/remaster source.",
    "Penalize covers, backing tracks, tutorials, commentary, unrelated videos, toys, drum scores, reactions, and vague explanation clips.",
    "Personal UP 4K remaster or lossless package sources are acceptable if the title clearly matches.",
    `Requested artist: ${artist}`,
    `Requested album: ${album}`,
    `Requested song: ${song}`,
    `Candidates: ${JSON.stringify(safeCandidates, null, 2)}`,
    "JSON schema: {\"items\":[{\"index\":0,\"aiScore\":0-100,\"label\":\"best|good|risky|bad\",\"reason\":\"short Chinese reason\"}]}"
  ].join("\n");
  const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.llm.apiKey}`
    },
    body: JSON.stringify({
      model: config.llm.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are a precise media metadata reviewer. Output strict JSON only." },
        { role: "user", content: prompt }
      ]
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = extractJsonObject(content);
  const reviewItems = Array.isArray(parsed)
    ? parsed
    : (parsed.items || parsed.candidates || parsed.results || []);
  const reviewByIndex = new Map(reviewItems.map((item) => [Number(item.index ?? item.candidateIndex), item]));
  const merged = (candidates || []).map((candidate, index) => {
    const review = reviewByIndex.get(index);
    return review ? {
      ...candidate,
      aiScore: Number(review.aiScore || 0),
      aiLabel: review.label || "",
      aiReason: review.reason || ""
    } : candidate;
  }).sort((a, b) => (Number(b.aiScore || -1) - Number(a.aiScore || -1)) || b.score - a.score);
  return {
    enabled: true,
    reviewedCount: reviewByIndex.size,
    reason: reviewByIndex.size ? "" : "大模型没有返回可用评分，已保留规则排序。",
    candidates: merged
  };
}

async function searchAudioContent({ query, limit = 12 }) {
  const q = String(query || "").trim();
  if (!q) return [];
  const terms = [
    q,
    `${q} 有声书`,
    `${q} 听书`,
    `${q} 评书`,
    `${q} 全集`
  ];
  const rows = [];
  const seen = new Set();
  for (const term of terms) {
    const search = await ytDlpJson(["--flat-playlist", "--dump-single-json", `bilisearch${Math.max(3, Math.ceil(limit / 2))}:${term}`]);
    for (const entry of search?.entries || []) {
      if (!entry?.url || seen.has(entry.url)) continue;
      seen.add(entry.url);
      const title = entry.title || term;
      const text = title;
      let score = 0;
      if (title.includes("评书") || title.includes("有声书") || title.includes("听书") || title.includes("广播剧")) score += 35;
      if (title.includes("全集") || title.includes("完整版") || title.includes("合集")) score += 15;
      if (normalizeSearch(text).includes(normalizeSearch(q))) score += 20;
      if (isBadCandidate(text)) score -= 30;
      rows.push({
        title,
        uploader: "",
        bvid: "",
        url: entry.url,
        duration: 0,
        viewCount: 0,
        score,
        kind: "audio-candidate"
      });
    }
  }
  return rows
    .sort((a, b) => b.score - a.score || b.viewCount - a.viewCount)
    .slice(0, 20);
}

async function resolveAudioContent(url) {
  if (!url) throw new Error("url is required.");
  const info = await ytDlpJson(["--dump-single-json", "--skip-download", url]);
  if (!info?.title) throw new Error("Unable to resolve Bilibili metadata.");
  return {
    title: info.title,
    uploader: info.uploader || "",
    bvid: info.id || "",
    url: info.webpage_url || url,
    duration: Number(info.duration || 0),
    viewCount: Number(info.view_count || 0),
    kind: Number(info.duration || 0) >= 1800 ? "long-audio" : "audio-candidate"
  };
}

async function downloadAudioContent({ title, url }, onProgress = () => {}) {
  if (!title || !url) throw new Error("title and url are required.");
  const config = await loadConfig();
  const targetDir = path.join(config.downloadRoot, "有声内容");
  await fs.mkdir(targetDir, { recursive: true });
  const safeTitle = sanitizeSegment(simplifyText(title));
  const template = path.join(targetDir, `${safeTitle}.%(ext)s`);
  onProgress({ progress: 5, message: `Downloading to ${targetDir}` });
  const result = await runCommandStreaming("yt-dlp", [
    ...YT_DLP_BROWSER_HEADERS,
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--force-overwrites",
    "-o",
    template,
    url
  ], (text) => {
    const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) onProgress({ progress: Math.min(90, 10 + Math.round(Number(match[1]) * 0.75)), message: text.trim() });
    else if (text.trim()) onProgress({ message: text.trim().slice(-240) });
  });
  const savedPath = path.join(targetDir, `${safeTitle}.mp3`);
  let exists = false;
  try {
    await fs.access(savedPath);
    exists = true;
  } catch {
    exists = false;
  }
  return { status: exists ? "downloaded" : "attempted", savedPath, code: result.code };
}

async function downloadTrack({ artist, album, song, url }, onProgress = () => {}) {
  if (!artist || !album || !song || !url) {
    throw new Error("artist, album, song, and url are required.");
  }
  const config = await loadConfig();
  const targetDir = path.join(config.downloadRoot, sanitizeSegment(artist), sanitizeSegment(album));
  await fs.mkdir(targetDir, { recursive: true });
  const outputTemplate = path.join(targetDir, `${sanitizeSegment(song)}.%(ext)s`);
  onProgress({ progress: 5, message: `Downloading to ${targetDir}` });
  const result = await runCommandStreaming("yt-dlp", [
    ...YT_DLP_BROWSER_HEADERS,
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--no-playlist",
    "--force-overwrites",
    "-o",
    outputTemplate,
    url
  ], (text) => {
    const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (match) {
      onProgress({ progress: Math.min(85, 10 + Math.round(Number(match[1]) * 0.7)), message: text.trim() });
    } else if (text.includes("[ExtractAudio]")) {
      onProgress({ progress: 90, message: "Converting audio to MP3" });
    } else if (text.trim()) {
      onProgress({ message: text.trim().slice(-240) });
    }
  });
  const savedPath = path.join(targetDir, `${sanitizeSegment(song)}.mp3`);
  let exists = false;
  try {
    await fs.access(savedPath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    onProgress({ progress: 94, message: "Writing MP3 metadata" });
    const taggedPath = path.join(targetDir, `${sanitizeSegment(song)}.tagged.mp3`);
    const tagResult = await runCommand("ffmpeg", [
      "-y",
      "-i",
      savedPath,
      "-map_metadata",
      "-1",
      "-metadata",
      `title=${song}`,
      "-metadata",
      `artist=${artist}`,
      "-metadata",
      `album=${album}`,
      "-codec",
      "copy",
      taggedPath
    ]);
    try {
      await fs.access(taggedPath);
      await fs.rename(taggedPath, savedPath);
    } catch {
      onProgress({ message: `Metadata update skipped: ${(tagResult.stderr || tagResult.stdout || "").slice(-180)}` });
    }
  }
  const trackId = findTrackId(artist, album, song);
  if (trackId) {
    const candidate = db.prepare("SELECT id FROM bilibili_candidates WHERE track_id = ? AND url = ?").get(trackId, url);
    db.prepare(`
      INSERT INTO downloads (track_id, candidate_id, saved_path, status)
      VALUES (?, ?, ?, ?)
    `).run(trackId, candidate?.id || null, savedPath, exists ? "downloaded" : "attempted");
  }
  return { status: exists ? "downloaded" : "attempted", savedPath, code: result.code, log: result.stdout + result.stderr };
}

async function downloadAlbum({ artist, album }, onProgress = () => {}) {
  if (!artist || !album) throw new Error("artist and album are required.");
  const profile = await getProfile(artist);
  const albumInfo = profile.albums.find((item) => normalizeSearch(item.album) === normalizeSearch(album));
  if (!albumInfo) throw new Error(`Album not found: ${album}`);
  const results = [];
  for (let index = 0; index < albumInfo.songs.length; index += 1) {
    const song = albumInfo.songs[index];
    const base = Math.round((index / Math.max(1, albumInfo.songs.length)) * 100);
    onProgress({ progress: base, message: `Searching ${index + 1}/${albumInfo.songs.length}: ${song}` });
    const candidates = await searchCandidates({ artist: profile.name, album: albumInfo.album, song, limit: 4 });
    const best = candidates[0];
    if (!best) {
      results.push({ song, status: "missing", message: "No candidate found" });
      continue;
    }
    onProgress({ progress: Math.min(98, base + 1), message: `Downloading ${index + 1}/${albumInfo.songs.length}: ${song}` });
    const result = await downloadTrack({
      artist: profile.name,
      album: albumInfo.album,
      song,
      url: best.url
    }, (patch) => {
      const local = Number(patch.progress || 0);
      const span = 100 / Math.max(1, albumInfo.songs.length);
      onProgress({
        progress: Math.min(99, Math.round(base + (local / 100) * span)),
        message: `${index + 1}/${albumInfo.songs.length} ${patch.message || song}`
      });
    });
    results.push({ song, candidate: best.title, ...result });
  }
  return {
    artist: profile.name,
    album: albumInfo.album,
    total: albumInfo.songs.length,
    downloaded: results.filter((item) => item.status === "downloaded").length,
    missing: results.filter((item) => item.status === "missing").length,
    results
  };
}

async function scanAlbum({ artist, album }, onProgress = () => {}) {
  if (!artist || !album) throw new Error("artist and album are required.");
  const profile = await getProfile(artist);
  const albumInfo = profile.albums.find((item) => normalizeSearch(item.album) === normalizeSearch(album));
  if (!albumInfo) throw new Error(`Album not found: ${album}`);
  const tracks = [];
  for (let index = 0; index < albumInfo.songs.length; index += 1) {
    const song = albumInfo.songs[index];
    onProgress({
      progress: Math.round((index / Math.max(1, albumInfo.songs.length)) * 95),
      message: `Scanning ${index + 1}/${albumInfo.songs.length}: ${song}`
    });
    const candidates = await searchCandidates({ artist: profile.name, album: albumInfo.album, song, limit: 4 });
    tracks.push({
      track: index + 1,
      artist: profile.name,
      album: albumInfo.album,
      song,
      selected: candidates[0]?.url || "",
      candidates
    });
  }
  return { artist: profile.name, album: albumInfo.album, total: tracks.length, tracks };
}

async function downloadSelection({ items }, onProgress = () => {}) {
  if (!Array.isArray(items) || !items.length) throw new Error("items is required.");
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item?.url) {
      results.push({ song: item?.song || "", status: "skipped" });
      continue;
    }
    const base = Math.round((index / Math.max(1, items.length)) * 100);
    onProgress({ progress: base, message: `Downloading ${index + 1}/${items.length}: ${item.song}` });
    const result = await downloadTrack(item, (patch) => {
      const span = 100 / Math.max(1, items.length);
      const local = Number(patch.progress || 0);
      onProgress({
        progress: Math.min(99, Math.round(base + (local / 100) * span)),
        message: `${index + 1}/${items.length} ${patch.message || item.song}`
      });
    });
    results.push({ song: item.song, ...result });
  }
  return {
    total: items.length,
    downloaded: results.filter((item) => item.status === "downloaded").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    results
  };
}

async function parseBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk.toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function serveStatic(req, res, pathname) {
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) return sendText(res, 403, "Forbidden");
  const type = resolved.endsWith(".css") ? "text/css; charset=utf-8"
    : resolved.endsWith(".js") ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
  try {
    await fs.access(resolved);
    res.writeHead(200, { "content-type": type });
    const stream = createReadStream(resolved);
    stream.on("error", () => {
      if (!res.headersSent) sendText(res, 404, "Not found");
      else res.end();
    });
    stream.pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function servePreview(req, res, pathname) {
  const name = path.basename(pathname);
  const filePath = path.join(PREVIEW_DIR, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PREVIEW_DIR)) || !name.endsWith(".mp3")) {
    return sendText(res, 403, "Forbidden");
  }
  try {
    const stat = await fs.stat(resolved);
    const range = req.headers.range;
    if (range) {
      const match = range.match(/bytes=(\d+)-(\d*)/);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : stat.size - 1;
      res.writeHead(206, {
        "content-type": "audio/mpeg",
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": end - start + 1,
        "cache-control": "public, max-age=86400"
      });
      createReadStream(resolved, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "content-type": "audio/mpeg",
      "accept-ranges": "bytes",
      "content-length": stat.size,
      "cache-control": "public, max-age=86400"
    });
    createReadStream(resolved).pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/artists" && req.method === "GET") {
      return sendJson(res, 200, await listArtists());
    }
    if (url.pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, publicConfig(await loadConfig()));
    }
    if (url.pathname === "/api/config" && req.method === "POST") {
      return sendJson(res, 200, publicConfig(await saveConfig(await parseBody(req))));
    }
    if (url.pathname === "/api/profile" && req.method === "GET") {
      return sendJson(res, 200, await getProfile(url.searchParams.get("artist")));
    }
    if (url.pathname === "/api/library-search" && req.method === "GET") {
      return sendJson(res, 200, await searchLibrary(url.searchParams.get("q")));
    }
    if (url.pathname === "/api/online-artists" && req.method === "GET") {
      return sendJson(res, 200, await searchOnlineArtists(url.searchParams.get("q")));
    }
    if (url.pathname === "/api/online-recordings" && req.method === "GET") {
      return sendJson(res, 200, await searchOnlineRecordings(url.searchParams.get("q")));
    }
    if (url.pathname === "/api/build-library" && req.method === "POST") {
      return sendJson(res, 200, await buildOnlineLibrary(await parseBody(req)));
    }
    if (url.pathname === "/api/build-library-job" && req.method === "POST") {
      const body = await parseBody(req);
      const job = createJob(`Build library: ${body.artistName}`);
      buildOnlineLibrary(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    if (url.pathname === "/api/build-recording-library-job" && req.method === "POST") {
      const body = await parseBody(req);
      const job = createJob(`Build recording library: ${body.artistName} - ${body.song}`);
      buildRecordingLibrary(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    if (url.pathname.startsWith("/api/jobs/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.replace("/api/jobs/", ""));
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { error: "Job not found." });
      return sendJson(res, 200, job);
    }
    if (url.pathname === "/api/search" && req.method === "GET") {
      return sendJson(res, 200, await searchCandidates({
        artist: url.searchParams.get("artist"),
        album: url.searchParams.get("album"),
        song: url.searchParams.get("song"),
        limit: Number(url.searchParams.get("limit") || 8)
      }));
    }
    if (url.pathname === "/api/llm-review" && req.method === "POST") {
      return sendJson(res, 200, await reviewCandidatesWithLlm(await parseBody(req)));
    }
    if (url.pathname === "/api/audio-search" && req.method === "GET") {
      return sendJson(res, 200, await searchAudioContent({
        query: url.searchParams.get("q"),
        limit: Number(url.searchParams.get("limit") || 12)
      }));
    }
    if (url.pathname === "/api/audio-resolve" && req.method === "GET") {
      return sendJson(res, 200, await resolveAudioContent(url.searchParams.get("url")));
    }
    if (url.pathname === "/api/preview-url" && req.method === "GET") {
      return sendJson(res, 200, await getPreviewUrl(url.searchParams.get("url")));
    }
    if (url.pathname === "/api/preview-file" && req.method === "GET") {
      return sendJson(res, 200, await getPreviewFile(url.searchParams.get("url")));
    }
    if (url.pathname === "/api/download" && req.method === "POST") {
      return sendJson(res, 200, await downloadTrack(await parseBody(req)));
    }
    if (url.pathname === "/api/download-job" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.iHaveRights) return sendJson(res, 403, { error: "Download requires rights confirmation." });
      const job = createJob(`Download: ${body.song}`);
      downloadTrack(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    if (url.pathname === "/api/download-album-job" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.iHaveRights) return sendJson(res, 403, { error: "Download requires rights confirmation." });
      const job = createJob(`Download album: ${body.album}`);
      downloadAlbum(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    if (url.pathname === "/api/scan-album-job" && req.method === "POST") {
      const body = await parseBody(req);
      const job = createJob(`Scan album: ${body.album}`);
      scanAlbum(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    if (url.pathname === "/api/download-selection-job" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.iHaveRights) return sendJson(res, 403, { error: "Download requires rights confirmation." });
      const job = createJob("Download selected sources");
      downloadSelection(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    if (url.pathname === "/api/download-audio-job" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.iHaveRights) return sendJson(res, 403, { error: "Download requires rights confirmation." });
      const job = createJob(`Download audio: ${body.title}`);
      downloadAudioContent(body, (patch) => updateJob(job, patch))
        .then((result) => finishJob(job, result))
        .catch((error) => failJob(job, error));
      return sendJson(res, 202, job);
    }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/preview-cache/")) return servePreview(req, res, pathname.replace("/preview-cache/", ""));
    return serveStatic(req, res, pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || String(error) });
  }
});

initDb();
await seedDbFromTracklists();

server.listen(PORT, HOST, () => {
  console.log(`Music Downloader running at http://${HOST}:${PORT}`);
  console.log(`Music root: ${MUSIC_ROOT}`);
  console.log(`SQLite DB: ${DB_PATH}`);
});
