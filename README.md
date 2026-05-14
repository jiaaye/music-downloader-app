# Music Downloader App

本地音乐下载器。核心链路不依赖大模型。主数据存储使用 SQLite：

```text
H:\音乐\music-downloader-app\music.db
```

1. 从本地 `tracklist.csv` 读取歌手、专辑、歌曲。
2. 启动时自动把 `tracklist.csv` 迁移/导入到 `music.db`。
3. 本地没有歌手时，可以用 MusicBrainz 在线搜索歌手并建立本地曲库。
4. 用户选择歌曲后，先查 SQLite 里的 B 站候选缓存，没有缓存再用 `yt-dlp` 搜索 B 站。
5. 用户确认有下载权并选择候选源。
6. 下载为 MP3 到配置的下载目录。

## 启动

```powershell
cd H:\音乐\music-downloader-app
npm start
```

打开：

```text
http://127.0.0.1:4587
```

## NAS / Docker 部署

最简单的 NAS 部署方式是 Docker。镜像里会安装 Node.js、`yt-dlp` 和 `ffmpeg`，应用数据放在 `./data`，音乐目录挂载到容器的 `/music`。

先编辑 `docker-compose.yml`，把左侧 NAS 音乐目录改成你的真实路径：

```yaml
volumes:
  - ./data:/data
  - /volume1/music:/music
```

例如群晖常见路径可能是 `/volume1/music`、`/volume1/音乐` 或你自己的共享文件夹路径。

启动：

```bash
docker compose up -d --build
```

打开：

```text
http://NAS_IP:4587
```

常用维护命令：

```bash
docker compose logs -f
docker compose pull
docker compose up -d --build
docker compose down
```

持久化文件：

```text
./data/config.json       配置和大模型 Key
./data/music.db          SQLite 本地曲库和候选源缓存
./data/preview-cache     试听缓存
/music                   实际音乐目录和下载目录
```

注意：不要把本机 Windows 的 `config.json` 直接打进镜像。Docker 版本默认使用 `/data/config.json`，首次启动后在页面里设置下载目录即可，容器内路径通常填 `/music`。

## 曲库格式

SQLite 是主库。`tracklist.csv` 保留为导入/导出格式。每个歌手一个目录，目录下可放：

```csv
album,song
SHERO,SHERO
SHERO,爱上你
```

默认音乐根目录是 app 上一级目录，也就是 `H:\音乐`。可以用环境变量覆盖：

```powershell
$env:MUSIC_ROOT="D:\Music"
npm start
```

## 在线建库

在线建库使用 MusicBrainz 元数据，不依赖大模型，也不预先搜索 B 站。默认只导入普通录音室专辑，过滤 MusicBrainz 标记为 live、compilation、video 等 secondary type 的 release group。

## 缓存

B 站候选源会写入 `bilibili_candidates` 表。7 天内再次搜索同一首歌时，会直接读取缓存，速度会明显快于重新访问 B 站。

## 繁简转换

建库时会保留原始歌手、专辑、歌曲名，同时用 `opencc-js` 生成简体显示/搜索字段。界面默认显示简体中文；B 站搜索也优先使用简体关键词，以提高中文内容命中率。例如本地曲库保留 `鄭智化`，界面和搜索使用 `郑智化`。

## 在线歌曲搜索

搜索框支持搜索歌曲名。本地没有结果时，可以使用在线歌曲搜索结果；选择结果后会先建立对应歌手曲库，再自动定位到该歌曲并搜索 B 站候选源。

## 专辑批量下载

选择专辑后可以批量下载当前专辑。批量下载会按专辑曲序逐首搜索候选源并下载评分最高的结果。批量下载和单曲下载都必须先在界面确认下载权，后端接口也会校验确认参数。

## 可选大模型增强

大模型默认关闭，不配置也能完整使用。启用后只作为辅助评审层：

```text
规则搜索 B 站候选源
→ 可选调用 OpenAI-compatible Chat Completions 接口
→ 给候选源重新排序并解释原因
→ 用户仍需试听/确认后下载
```

配置项在主页面左侧“大模型增强”里：

```text
Base URL: https://api.openai.com/v1 或其他兼容接口
Model: gpt-4o-mini 或其他模型
API Key: 本地保存到 config.json
```

接口不会在 `/api/config` 里回传 API Key，只返回 `hasApiKey` 状态。
