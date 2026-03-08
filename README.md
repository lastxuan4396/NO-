# NVC Couple Share

情侣非暴力沟通（NVC）练习页，支持：
- 四步表达（观察-感受-需要-请求）
- A/B 回合模式与复述确认
- 后端短链分享（带过期时间）
- 历史时间轴
- JSON 导入/导出（含 schema 版本迁移）
- PWA 安装与离线缓存

## Tech Stack

- Frontend: 单页 HTML/CSS/JS（`index.html`）
- Backend: Node.js + Express（`server.js`）
- Storage:
  - 优先使用 Postgres（`DATABASE_URL`）
  - 兜底文件存储（`shortlinks-store.json`）
- E2E: Playwright
- CI: GitHub Actions

## Local Development

```bash
npm install
npm run build:config
npm start
```

默认端口：`10000`

## Environment Variables

### Frontend (static build)
- `NVC_API_BASE`: 前端调用短链 API 的基地址（示例：`https://nvc-couple-links.onrender.com`）

### Backend
- `DATABASE_URL`: Postgres 连接串（配置后自动启用 Postgres）
- `SHORTLINK_STORAGE`: `postgres` / `file`（默认自动判断）
- `SHORTLINK_TTL_DAYS`: 短链有效期，默认 `30`
- `SHORTLINK_CLEANUP_INTERVAL_MS`: 过期清理周期，默认 `600000`
- `PUBLIC_BASE_URL`: 返回给前端的短链域名前缀（建议填前端域名）
- `CORS_ALLOW_ORIGINS`: 允许的跨域来源，逗号分隔
- `RATE_LIMIT_WINDOW_MS`: 限流窗口，默认 `60000`
- `RATE_LIMIT_WRITE_MAX`: 写接口窗口内最大请求，默认 `40`
- `RATE_LIMIT_READ_MAX`: 读接口窗口内最大请求，默认 `160`
- `SENTRY_DSN`: 可选，配置后启用后端异常上报
- `SENTRY_ENV`: 可选，Sentry 环境名

## Data Schema

导出 JSON 当前版本：`schemaVersion: 2`

`v1 -> v2` 自动迁移内容：
- `version` 映射为 `schemaVersion`
- `history` 条目补齐 `roundNo`、字符串字段裁剪
- `metrics` 做数字归一化

## Tests

```bash
npm run test:e2e
```

本地首次运行 Playwright 需要安装浏览器：

```bash
npx playwright install chromium
```

## CI

工作流文件：`.github/workflows/ci.yml`

触发：
- push 到 `main`
- pull request

执行步骤：
1. `npm ci`
2. 安装 Playwright Chromium
3. `npm run build:config`
4. `npm run test:e2e`

## Render Deployment

仓库内已提供 Blueprint：`render.yaml`

包含资源：
- `nvc-couple-share`（Static）
- `nvc-couple-links`（Web）
- `nvc-shortlinks-db`（Postgres）

## Security Notes

- 请只使用最小权限 token。 
- 若 token 曾在聊天或截图中暴露，务必立即 **Revoke 并重建**。
- 建议打开 Render 告警（部署失败、服务异常）并配合 Sentry 监控。
