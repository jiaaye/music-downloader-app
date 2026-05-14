# 发布说明

这个项目最适合按 Docker 应用发布：

- GitHub 保存源码和版本。
- GitHub Container Registry 保存预构建镜像。
- 用户复制 `docker-compose.example.yml`，改音乐目录后启动。

## 发布前检查

不要提交这些本地文件：

```text
config.json
music.db
music.db-shm
music.db-wal
preview-cache/
data/
server.out.log
server.err.log
```

`.dockerignore` 已经排除了它们；如果使用 git，还需要确认 `.gitignore` 也排除这些文件。

## 第一次发布

1. 新建 GitHub 仓库，例如：

```text
music-downloader-app
```

2. 初始化并推送源码：

```bash
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/jiaaye/music-downloader-app.git
git push -u origin main
```

3. 打版本标签：

```bash
git tag v0.1.0
git push origin v0.1.0
```

推送 `v0.1.0` 后，GitHub Actions 会自动构建并发布镜像：

```text
ghcr.io/jiaaye/music-downloader-app:v0.1.0
ghcr.io/jiaaye/music-downloader-app:latest
```

## 用户安装方式

让用户保存 `docker-compose.example.yml`，把音乐目录改成自己的 NAS 路径：

```yaml
volumes:
  - ./data:/data
  - /volume1/music:/music
```

启动：

```bash
docker compose up -d
```

访问：

```text
http://NAS_IP:4587
```

## 更新版本

你改完代码后：

```bash
git add .
git commit -m "Update downloader"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

用户更新：

```bash
docker compose pull
docker compose up -d
```

## 发布页建议写清楚

- 这是本地工具，用户必须确认自己有下载权。
- 大模型是可选增强，不配置也能跑。
- B 站搜索和下载依赖 `yt-dlp`，平台规则变化可能影响可用性。
- 配置和数据库都在 `./data`，升级镜像不会丢。
