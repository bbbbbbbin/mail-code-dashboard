# iCloud 多账号收件台

## Linux / Docker 服务器版

新增独立服务器入口：统一多账号后台、Chrome 账号配对同步、永久单邮箱分发与 Token 管理。
本机版本仍保留；两者不是简单的端口开放关系。

- [服务器部署与权限说明](docs/server-deployment.md)
- [现有 4173 / 4174 的后续迁移清单](docs/server-migration.md)
- [服务器版验收记录与复现方法](docs/server-verification.md)

只有明确分发邮箱时生成收件 Token，默认永久有效；迁移、同步和自动生成邮箱不创建 Token。
真实账号迁移与部署需在服务器版验收之后单独执行，当前本机数据不自动改动。

## 本机版本（原有功能保留）

本机入口在单个 Node.js 服务中管理 iCloud 隐藏邮箱库存、原子领取记录和转发邮件。该入口强制监听 `127.0.0.1`，所有 `/v1/*` 与旧 `/api/*` 业务接口都要求 `X-API-Key`。

## 准备

- Node.js ≥ 22.13（`package.json` 的 `engines` 已声明该下限，由 `jsdom` 的 `^22.13.0` 决定；开发机跑的是 23.x，上游更推荐 Node.js 24 或兼容的 LTS 版本）
- Python 与 Playwright（仅浏览器 smoke 测试需要）
- iCloud+、已登录 iCloud 的 Chrome（独立配置文件）及本项目附带的 Cookie 同步扩展
- 可选：一个支持 IMAP 的转发邮箱

安装依赖：

```powershell
npm install
```

## API Key

未提供环境变量时，服务首次启动会创建：

```text
runtime/api-key.txt
```

启动日志只打印该文件路径，不打印内容。页面要求输入 key，并只保存在当前标签页的 `sessionStorage`。

也可以在启动前提供环境变量：

```powershell
$env:MAIL_DASHBOARD_API_KEY = "<local-secret>"
```

不要把 key 写进仓库、命令历史、截图或日志。

## 启动

前台启动（默认）：

```powershell
.\scripts\start_dashboard.ps1
```

作为本机辅助进程隐藏启动：

```powershell
.\scripts\start_dashboard.ps1 -Hidden
```

也可以直接运行：

```powershell
$env:HOST = "127.0.0.1"
node server.mjs
```

浏览器只使用：

```text
http://127.0.0.1:4173/
```

脚本和服务会拒绝非 `127.0.0.1` 的 `HOST`。

### 日志

`logs/server-lifecycle.log` 超过 2 MiB 时自动轮转为 `.1`、`.2`，最多保留 2 代，占用有上限。以下环境变量可调：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAIL_LIFECYCLE_LOG_PATH` | `logs/server-lifecycle.log` | 覆盖日志路径；隔离验收时可指向临时目录 |
| `MAIL_LIFECYCLE_LOG_MAX_BYTES` | `2097152` | 单个日志文件的字节上限（64 KiB – 128 MiB） |
| `MAIL_LIFECYCLE_LOG_BACKUPS` | `2` | 保留几代旧日志；设为 `0` 表示直接丢弃 |

## 后台自动生成

自动生成由 **Node 服务**执行，不依赖项目页面、当前标签页或浏览器定时器。
电脑和服务保持运行时，最迟每 30 秒检查一次计划；每小时最多一批、每批最多 5 个，
库存目标为 1500 个。关闭页面仍继续；电脑休眠或服务退出时暂停，恢复后只运行到期的一批，
不补发休眠期间错过的全部批次。

开关、标签前缀、下次执行时间、失败次数写入该实例的库存状态文件，并与库存一同原子保存。
首次升级打开页面时只迁移一次原浏览器设置；后续页面以服务器状态为准，多个标签页不会重复启动任务。
新安装在首次配置前保持关闭。手动生成与后台任务共用执行队列，并由服务端保存生成结果。
手动成功也会推迟下一次自动生成，避免紧接着再触发一批。

普通失败约 5 分钟后重试，连续 3 次失败或遇到登录/限额问题延后约 1 小时。
若生成请求超时、库存保存失败或进程在生成中断开，会暂停并显示待核对提示；
先点击“同步 iCloud”恢复库存，再重新开启自动生成，避免盲目重复申请地址。

接口均需要 `X-API-Key`：

- `GET /v1/auto-stock`：读取计划、状态与目标。
- `PATCH /v1/auto-stock`：更新 `{ "enabled": true, "prefix": "hme" }`；切换开关不清空冷却时间。
- `POST /v1/auto-stock/initialize`：一次性迁移旧浏览器设置，已配置的实例不被其他页面覆盖。

## 多 iCloud 账号 / 多实例

同一份代码可以启动多个本机服务，但每个账号必须使用独立的 Cookie、库存状态、
备份、API key、标签序列、转发配置和日志。只更换
`HME_COOKIE_FILE` 而共用其他状态文件，会把两个账号的领取记录和库存混在一起。

使用按实例隔离的启动脚本：

```powershell
.\scripts\start_dashboard_instance.ps1 `
  -InstanceDir "$env:LOCALAPPDATA\icloud-hme\account-a" `
  -Port 4173

.\scripts\start_dashboard_instance.ps1 `
  -InstanceDir "$env:LOCALAPPDATA\icloud-hme\account-b" `
  -Port 4174
```

脚本默认在实例目录下创建以下文件：

```text
cookies.txt
dashboard-state-v1.json
api-key.txt
icloud-label-sequence.json
mail-forward.config.json
backups\
logs\
```

需要后台运行时，在命令后加 `-Hidden`。每个实例的标准输出、错误输出和生命周期日志
也会写入各自的 `logs`，不会抢占另一个实例的日志文件。
隔离启动脚本会设置 `HME_COOKIE_REFRESH_MODE=extension`：仅使用对应 Chrome/Edge
配置文件扩展推送的 Cookie，不自动扫描其他 Edge 配置文件。Cookie 过期时，
在对应账号的 Chrome 中登录 iCloud，并使用该 Chrome 的扩展同步至对应端口。

如果要保留已有的默认账号数据，可继续使用原来的 `runtime` 路径启动账号 A，账号 B
使用新的 `account-b` 目录；启动脚本支持 `-ForwardConfig` 和 `-LabelSequenceFile`
覆盖这两个特殊路径。

## iCloud Cookie 刷新

生成隐藏邮箱要用 `runtime/cookies.txt` 里的 iCloud 登录 cookie。服务在 cookie 超过 2 小时未更新时按顺序尝试三条刷新路径：

| 路径 | 入口 | 前置条件 |
| --- | --- | --- |
| CDP 桥接 | `scripts/debug_icloud_cookie_bridge.ps1` | Edge 以 `--remote-debugging-port=9222` 启动，且装有 iCloud Cookie Bridge 扩展 |
| DPAPI 直读 | `scripts/refresh_edge_icloud_cookies.py` | Edge 用 `v10`/`v11` 加密 cookie（Edge 127 起改用 app-bound `v20`，这条路径就不再可用） |
| 扩展直推 | `POST /api/edge-cookie-bridge` | 在扩展弹窗里填好本机 API Key |

iCloud 登录态不一定在 `Default` 配置文件里。两个脚本都读 `EDGE_PROFILE` 环境变量，Python 脚本在未设置时会自动扫描所有配置文件。

三条路径全部失败时，`GET /api/icloud/status` 会带上 `stale`、`ageMinutes` 和 `lastRefreshError`，收件台顶栏也会提示“cookie 已过期，需手动刷新”，不必去翻 `logs/server.err.log`。

手动恢复：关闭 Edge，用带调试端口的方式重开（`--remote-debugging-port=9222 --remote-allow-origins=* --profile-directory="<你的配置文件>"`），登录 icloud.com，再在扩展弹窗里推一次 cookie。

## 前端设计系统

`assets/design-system.css` 与 `assets/design-system.js` 是设计系统的权威定义。新页面必须引用它们，不要自己写颜色、字号、间距的字面量；`design-system.html` 和收件台都已经接入。

收件台 `mail-code-dashboard.html` 不含内联样式或业务脚本，按顺序加载共享设计系统和页面专用的 `assets/dashboard.css`。浏览器逻辑拆为 state、API、mail、UI 与入口五个 ES module；非入口模块可直接导入测试，只有入口负责绑定事件和定时器。

活样式指南（所有令牌与组件的实际形态）：

```text
http://127.0.0.1:4173/design-system.html
```

规则、令牌表和可访问性基线见 [docs/design-system.md](docs/design-system.md)。

## 配置转发邮箱

复制脱敏示例：

```powershell
Copy-Item .\mail-forward.config.example.json .\mail-forward.config.json
```

然后只在本地填写 IMAP 主机、转发邮箱账号和应用授权码。可配置：

- `mailboxes`：按顺序扫描的文件夹；
- `messageLimit`：最近邮件、单地址邮件列表等即时视图每个文件夹最多读取的最新
- `pollIntervalMs`：有界轮询间隔。

`mail-forward.config.json` 已被 Git 忽略。没有该文件时，MIME fixture 测试仍可验证匹配和解析，但真实 IMAP 验收仍是待配置项。

## 原浏览器迁移

旧分组保存在具体浏览器的 `mail-code-dashboard-v1` 中，服务端不能自行读取。

1. 启动升级后的本机服务。
2. 使用保存了真实“未使用 / 已使用 / 垃圾箱”状态的原浏览器打开页面。
3. 输入本机 API Key。
4. 页面只显示迁移总数和三组计数，不会自动提交。
5. 核对计数后点击“确认迁移到服务端”。
6. 再次核对服务端计数。

原 `localStorage` 值不会被删除或重写。首次迁移后，其他浏览器不能自动覆盖服务端库存。

## iCloud 官方同步

`POST /v1/inventory/sync-icloud` 按邮箱地址合并 Apple 当前有效的隐藏邮箱列表。Apple 标签是唯一权威值：兼容字段 `label` 与 `appleLabel` 会同时保存官方标签，不再按列表位置生成 `hme-*` 本地标签；官方标签为空时也保持为空。

同步会补入官方存在但本地缺失的邮箱，并刷新已有行的官方标签、匿名标识和启用状态；不会覆盖分组、备注、领取记录或邮件状态，也不会自动删除本地独有行。Apple 拉取失败时整批不落盘。核对数量时应统计实际唯一邮箱，不能把 `hme-358` 这样的最大标签编号当成 358 个邮箱。

## 调用领取 API

以下命令把 key 放在变量中，不回显其值：

```powershell
$apiKeyPath = Join-Path $PWD "runtime\api-key.txt"
$headers = @{
  "X-API-Key" = (Get-Content -Raw -LiteralPath $apiKeyPath).Trim()
  "Idempotency-Key" = "registration-example-001"
}

$claim = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:4173/v1/claims" `
  -Headers $headers

$claimId = $claim.data.claimId
```

轮询最新邮件、列出邮件和释放：

```powershell
$auth = @{ "X-API-Key" = $headers["X-API-Key"] }

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4173/v1/claims/$claimId/messages/latest?waitSeconds=30" `
  -Headers $auth

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4173/v1/claims/$claimId/messages?limit=20" `
  -Headers $auth

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:4173/v1/claims/$claimId/release" `
  -Headers $auth `
  -ContentType "application/json" `
  -Body '{"reason":"synthetic caller cancellation"}'
```

完整 API 和 curl 示例见 [docs/api.md](docs/api.md)。

## 状态备份与恢复

运行时数据分三类：

```text
runtime/dashboard-state-v1.json             # 当前权威库存、领取与幂等键
runtime/backups/                            # 浏览器迁移原始快照、永久删除的单行备份
runtime/archive/dashboard-archive-YYYY-MM-DD.json
                                            # 到期的已释放领取与对应幂等键
```

默认保留最近 30 天的已释放领取；`MAIL_DASHBOARD_ARCHIVE_RETENTION_DAYS`
可改为非负天数。归档只在下一次状态写操作中触发，且是 fail-closed：

- 活跃领取、仍被库存项引用的领取、缺少 `claimId` 或 `releasedAt` 无法解析的记录不会被猜测性归档；
- 幂等键与它指向的领取一起移动，避免重试命中一个已不存在的热数据记录；
- 同一天的归档按 `claimId` 和幂等键合并，重复扫不会重复追加；
- 归档写入失败或归档 JSON 损坏时，本次状态修改返回 `STORAGE_ERROR`，当前状态文件不落盘，损坏归档也不会被覆盖。

状态、备份与归档文件按 `0600` 创建，归档目录在支持 POSIX mode
的平台按 `0700` 创建；Windows 仍继承当前用户目录的 NTFS ACL，因此不要把
`runtime/` 放到共享目录。所有这些文件都被 Git 忽略。

人工恢复必须先停止服务，并先复制整个 `runtime/` 到另一个仅当前用户可读的位置：

1. **完整状态损坏**：恢复你事先保存的完整 `dashboard-state-v1.json`。不要把
   `local-storage-*.json` 直接改名成状态文件——它只是浏览器提交的数组，不是状态文件格式。
   如果只有这份迁移快照，把损坏状态移到取证副本后，将数组作为 `records` 提交到
   `POST /v1/migrations/local-storage` 重新初始化。服务不会自动保存完整状态世代，
   所以外部定期备份仍是完整恢复的唯一来源。
2. **误删单条库存**：打开对应
   `inventory-deleted-<时间戳>-<id>.json`，取其中的 `item`；在离线副本里确认
   `id` 和邮箱都没有冲突，再把该对象追加回完整状态的 `inventory` 数组。保留原删除备份，
   用临时文件写完并校验 JSON 后再替换权威状态文件。
3. **归档损坏**：先保留损坏文件，核对日期后将它移出 `runtime/archive/`。
   下一次写操作会为仍留在权威状态中的到期记录新建干净归档；已经只存在于损坏文件中的
   历史需要从外部备份恢复，不能从当前状态推导。
4. 重启后先调用只读库存接口核对总数和三组计数；核对完成前不要领取、释放、迁移或修改库存。

损坏的状态文件会返回 `STORAGE_ERROR`，服务不会用空库存或最新 iCloud 列表静默覆盖它。

## 验证

```powershell
npm test
python -m unittest discover -s test -p "test_*.py" -v

node .\scripts\smoke_custom_prefix.mjs
node .\scripts\smoke_epipe_guard.mjs
node .\scripts\smoke_isolated_server.mjs
node .\scripts\smoke_manual_generation_only.mjs

python .\scripts\smoke_dashboard.py
python .\scripts\smoke_migration.py
python .\scripts\smoke_mail_viewer.py
python .\scripts\smoke_tabs_settings.py
python .\scripts\smoke_layout_overflow.py
python .\scripts\smoke_icloud_controls.py
python .\scripts\smoke_icloud_status.py

git check-ignore -v `
  .\mail-forward.config.json `
  .\runtime\api-key.txt `
  .\runtime\dashboard-state-v1.json
```

`npm test`、上述静态公开面 Python unittest、`ruff check`（规则集在仓库根的 `ruff.toml`）和插件配置冒烟由 `.github/workflows/ci.yml` 在每次推送和 PR 上跑。上面的 Playwright smoke 需要真实浏览器和运行中的服务，属于发版前的本机步骤，没有进 CI。本机跑 lint：

```powershell
pip install ruff==0.16.0
ruff check .
```

常见稳定错误包括 `UNAUTHORIZED`、`INVENTORY_EMPTY`、`CLAIM_NOT_FOUND`、`CLAIM_RELEASED`、`INVENTORY_ALREADY_INITIALIZED`、`MAILBOX_NOT_CONFIGURED`、`MAILBOX_UNAVAILABLE`、`BAD_REQUEST` 和 `STORAGE_ERROR`。

## 安全边界

- 不要公网部署、内网穿透或改为全接口监听。
- 不要提交或分享 Cookie、IMAP 授权码、Refresh Token、API Key、运行时状态、备份、日志、邮件正文或验证码。
- 服务不会访问从邮件中提取出的链接。
- 邮件 HTML 会先清理；页面仅在无脚本权限的 sandbox iframe 中展示清理后的 HTML。

## Chrome 扩展

在 Chrome 的扩展管理页开启开发者模式，加载 [extensions/chrome-cookie-bridge](extensions/chrome-cookie-bridge/README.md)。
每个 Chrome 配置文件只登录自己的 iCloud 账号；扩展绑定对应的本机端口和该实例的 API Key。
多实例务必使用 `start_dashboard_instance.ps1`，它只接收对应扩展推送的 Cookie，避免读取其他浏览器账号。

## 独立仓库说明

本仓库包含收件台、库存与领取 API、后台隐藏邮箱生成和 Chrome Cookie 扩展。
从本机工具集中按源码文件导出，采用全新 Git 历史，不附带原仓库历史、账号配置、邮件或运行状态。
首次使用请创建自己的转发配置和实例目录；本项目不附带任何可用账号、Cookie 或密钥。
