# Mail Code Dashboard API

本文描述单机模式 API。服务器模式的权限与接口见 [服务器部署指南](server-deployment.md)。`PORT` 为服务配置的监听端口。

基础地址：

```text
http://127.0.0.1:PORT
```

所有 `/v1/*` 请求必须携带：

```http
X-API-Key: TOKEN
```

成功和失败都使用固定信封：

```json
{
  "ok": true,
  "data": {},
  "error": null,
  "meta": {
    "service": "mail-code-dashboard",
    "version": "1",
    "requestId": "request-id"
  }
}
```

## 后台自动生成

所有接口均要求 `X-API-Key`。任务由本机服务执行，关闭浏览器页面不影响计划。

- `GET /v1/auto-stock` 返回 `configured`、`enabled`、`prefix`、`running`、`total`、
  `targetTotal`、`batchSize`、`intervalMs`、`lastGeneratedAt`、`nextAttemptAt`、`failureCount`、`lastError`、`pausedReason`。
- `PATCH /v1/auto-stock` 接受 `{ "enabled": true, "prefix": "hme" }`，也可以只修改其中一项。
  前缀必须为 1–32 位字母/数字/下划线/连字符，首位为字母或数字。切换开关保留冷却时间。
- `POST /v1/auto-stock/initialize` 仅在尚未配置时迁移一次浏览器设置；后续调用不覆盖已有计划。
  可传 `lastGeneratedAt`、`nextAttemptAt`、`pausedReason`，这些字段只用于首次迁移。

默认每小时最多一批、每批 5 个、目标 1500；新安装配置前关闭。人工生成也会影响冷却时间。
结果不确定或上次生成被中断时返回待核对提示，先 `POST /v1/inventory/sync-icloud` 恢复库存，
然后重新开启自动生成。不要通过反复切换开关来重放未确认的生成请求。

## 库存与迁移

### `GET /v1/inventory`

返回：

- `initialized`：原浏览器迁移是否已显式完成；
- `migration`：迁移完成时间与备份文件名，未迁移时为 `null`；
- `summary`：总数及三组计数；
- `inventory`：服务端权威库存；
- `claims`：领取历史。

### `POST /v1/inventory`

把新生成的隐藏邮箱写进服务端权威库存，支持一次提交多条：

```json
{
  "addresses": [
    {
      "email": "synthetic.alias@icloud.com",
      "label": "hme-001",
      "remark": "hme-001",
      "appleLabel": "hme-001",
      "isActive": true,
      "statusType": "ok",
      "statusMessage": "已生成，等待使用"
    }
  ]
}
```

返回 `{ summary, created, existing, inventory, claims }`，前端可以直接用它刷新整页。`created` 是本次新建的行，`existing` 是已经存在、只做了刷新的行。

幂等键是邮箱地址本身：同一地址重复提交不会产生第二条库存项，也不需要 `Idempotency-Key`。（`POST /v1/claims` 需要那个请求头是因为它会消耗一个地址；这里的地址自带唯一身份，重试天然收敛，而且一个请求头也没法覆盖批量里只重叠一部分的重试。）

新地址一律以 `unused` 写入。`group`、`id`、`activeClaimId` 和邮件字段由服务端决定，请求里带上会被静默忽略。可提交字段：`email`、`label`、`remark`、`source`、`appleLabel`、`anonymousId`、`isActive`、`statusType`、`statusMessage`；`remark` 省略时取 `label`。

Apple 标签是唯一权威值。新地址的 `label` 与 `appleLabel` 保存同一个官方标签；已存在地址收到 `appleLabel` 或非空 `label` 时会同时刷新这两个兼容字段。分组、备注、领取状态和邮件状态不会被覆盖。

```bash
curl -X POST http://127.0.0.1:PORT/v1/inventory \
  -H "X-API-Key: $MAIL_DASHBOARD_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"addresses":[{"email":"synthetic.alias@icloud.com","label":"hme-001"}]}'
```

边界：

- `addresses` 不是数组、单条不是对象、`email` 缺失或不含 `@`，返回 HTTP 400 / `BAD_REQUEST`；
- 单批最多 100 条，超出返回 HTTP 400 / `BAD_REQUEST`；
- 整批先校验再落盘：任意一条不合法就整批拒绝，不会只写进合法的那几条，整批只写一次状态文件；
- 同一批内重复的地址不区分大小写去重，保留第一条；
- `addresses` 为空数组时不写状态文件，只回当前库存。

### `POST /v1/migrations/local-storage`

只允许首次显式迁移：

```json
{
  "records": [
    {
      "email": "synthetic.alias@icloud.com",
      "group": "finished",
      "label": "hme-001",
      "remark": "synthetic note",
      "unread": false
    }
  ]
}
```

重复首次迁移返回 HTTP 409 / `INVENTORY_ALREADY_INITIALIZED`，不会覆盖已有库存。

### `PATCH /v1/inventory/{id}`

局部更新一条库存，返回 `{ "inventoryItem": ... }`。只接受白名单字段，其余字段静默忽略：

```json
{
  "group": "finished",
  "remark": "synthetic note",
  "lastMethod": "Forward IMAP/Junk"
}
```

白名单：`group`、`label`、`remark`、`code`、`subject`、`preview`、`receivedAt`、`unread`、`statusType`、`statusMessage`、`lastCheckedAt`、`lastMethod`、`noCodeReason`、`isActive`。

边界：

- `group` 只能是 `unused` / `finished` / `trash`，否则 HTTP 400 / `BAD_REQUEST`；
- 库存项不存在返回 HTTP 404 / `INVENTORY_NOT_FOUND`；
- 该地址仍有未释放的领取时改分组返回 HTTP 409 / `CLAIM_ACTIVE`，其余字段的改动不受影响。

### `DELETE /v1/inventory/{id}`

把一条**垃圾箱**里的地址从库存永久移除，返回 `{ deleted, summary, inventory, claims }`：

```bash
curl -X DELETE http://127.0.0.1:PORT/v1/inventory/$ID \
  -H "X-API-Key: $MAIL_DASHBOARD_API_KEY"
```

删除前服务端会先把整条记录写到 `runtime/backups/inventory-deleted-<时间戳>-<id>.json`（含 `deletedAt`），误删可以照着手工恢复。

边界：

- 只有 `group` 为 `trash` 的行可删，否则 HTTP 409 / `INVENTORY_NOT_IN_TRASH`；
- 该地址仍有未释放的领取时返回 HTTP 409 / `CLAIM_ACTIVE`，先调 `POST /v1/claims/{claimId}/release`；
- 库存项不存在返回 HTTP 404 / `INVENTORY_NOT_FOUND`。

**不会**同步停用 Apple 侧的隐藏邮箱。该接口作用于主 Apple ID，误操作代价过高，因此保持手动：需要时到 iCloud 设置里自行停用。

### `POST /v1/inventory/{id}/messages/latest`

对单条库存立即查一次转发邮箱（不等待），把最新邮件写回该行：

```json
{
  "checked": 1,
  "updated": 1,
  "moved": 1,
  "errors": [],
  "inventoryItem": {},
  "message": {}
}
```

没有匹配邮件时 `updated` 为 0、`message` 为 `null`，只刷新 `lastCheckedAt`。命中邮件且该行原本在 `unused` 时自动移入 `finished`（`moved` 为 1）。转发邮箱不可用不会中断请求：该行写入 `statusType: "error"`，错误进入 `errors`，`message` 为 `null`。库存项不存在返回 HTTP 404 / `INVENTORY_NOT_FOUND`。

### `POST /v1/inventory/check-unused-mail`

批量扫描 `unused` 组中仍启用（`isActive`）的地址，命中邮件的行移入 `finished`：

```bash
curl -X POST http://127.0.0.1:PORT/v1/inventory/check-unused-mail \
  -H "X-API-Key: $MAIL_DASHBOARD_API_KEY"
```

返回 `checked`、`updated`、`moved`、`errors`、`inventory`。整批只读写一次状态文件；扫描期间被人工改过分组的行会被跳过，保留新分组。并发调用共用同一次扫描，不会开两个 IMAP 会话。

### `POST /v1/inventory/check-finished-mail`

同上，但扫描 `finished` 组且不搬动分组，返回体没有 `moved`。同样并发合流。

### `POST /v1/inventory/sync-icloud`

拉取 Apple 隐藏邮箱列表并合并进库存，返回 `{ summary, inventory, claims }`。

新地址以 `unused` 写入。Apple 列表标签会同时写入 `label` 与 `appleLabel`，已存在地址也会收敛到官方标签；官方标签为空时保持为空，不生成本地 `hme-*` 兜底。同步仍不会覆盖分组、备注、领取状态或邮件状态，也不会自动删除本地独有地址。需要本地 iCloud 登录态（`runtime/cookies.txt`），拉取失败时整批不落盘。

## 领取

### `POST /v1/claims`

必须提供非空且不超过 200 字符的 `Idempotency-Key`：

```powershell
$headers = @{
  "X-API-Key" = $env:MAIL_DASHBOARD_API_KEY
  "Idempotency-Key" = "synthetic-job-001"
}
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:PORT/v1/claims" `
  -Headers $headers
```

相同幂等键始终返回原领取记录，不会消耗第二个地址。

curl：

```bash
curl -X POST http://127.0.0.1:PORT/v1/claims \
  -H "X-API-Key: $MAIL_DASHBOARD_API_KEY" \
  -H "Idempotency-Key: synthetic-job-001"
```

### `GET /v1/claims/{claimId}`

查询单个领取记录。不存在时返回 HTTP 404 / `CLAIM_NOT_FOUND`。

### `POST /v1/claims/{claimId}/release`

```json
{
  "reason": "synthetic caller cancellation"
}
```

释放幂等：重复请求保留首次 `releasedAt` 和 `releaseReason`。只有仍与该领取关联的库存项才恢复为 `unused`。

## 邮件

### `GET /v1/claims/{claimId}/messages?limit=20`

`limit` 范围为 1–100，返回按时间倒序的 `messages`。

### `GET /v1/claims/{claimId}/messages/latest?waitSeconds=30`

`waitSeconds` 范围为 0–30。正常超时返回：

```json
{
  "message": null
}
```

释放后的领取返回 HTTP 409 / `CLAIM_RELEASED`。

邮件对象包含发件人、主题、时间、完整安全文本、清理后的 HTML、验证码数组、全部 HTTP(S) 链接和 `primaryLink`。响应不会包含原始 MIME、原始邮件头、IMAP 凭据或匹配内部字段。服务不会请求这些链接。

## HTTP 状态与错误

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数、请求体、幂等键或查询边界无效 |
| 401 | `UNAUTHORIZED` | API Key 缺失或错误 |
| 404 | `CLAIM_NOT_FOUND` | 领取记录不存在 |
| 404 | `INVENTORY_NOT_FOUND` | 库存项不存在 |
| 409 | `INVENTORY_EMPTY` | 没有可领取邮箱 |
| 409 | `CLAIM_RELEASED` | 领取已释放 |
| 409 | `CLAIM_ACTIVE` | 库存项仍有未释放的领取，需先释放才能改分组或删除 |
| 409 | `INVENTORY_NOT_IN_TRASH` | 只有垃圾箱里的地址可以永久删除 |
| 409 | `INVENTORY_ALREADY_INITIALIZED` | 首次迁移已完成 |
| 409 | `SCAN_IN_PROGRESS` | 有限扫描已先运行，持久化 `incremental` / `full` 扫描不能同时启动 |
| 502 | `MAILBOX_UNAVAILABLE` | IMAP 连接或认证失败 |
| 503 | `MAILBOX_NOT_CONFIGURED` | 未配置转发邮箱 |
| 500 | `STORAGE_ERROR` | 状态文件损坏或无法原子读写 |

## 恢复与忽略检查

状态文件、备份与领取归档均在 `runtime/`，不属于源代码。已释放领取和对应幂等键默认保留 30 天，之后在下一次状态写入时合并进 `runtime/archive/dashboard-archive-YYYY-MM-DD.json`；可用 `MAIL_DASHBOARD_ARCHIVE_RETENTION_DAYS` 调整。活跃、仍被库存引用或时间不可解析的领取不会被归档。归档写入/解析失败会让整次修改以 `STORAGE_ERROR` 失败，不会先删热数据或覆盖损坏文件。

人工恢复必须在服务停止后进行，并在重新启用领取前核对三组计数。迁移快照是原始数组，不能直接改名为权威状态；永久删除会先生成 `runtime/backups/inventory-deleted-*.json` 单行备份。完整恢复、单行回填、损坏归档隔离和权限说明见 [README 的“状态备份与恢复”](../README.md#状态备份与恢复)。


```powershell
git check-ignore -v `
  .\mail-forward.config.json `
  .\runtime\api-key.txt `
  .\runtime\dashboard-state-v1.json `
  .\runtime\backups\synthetic-backup.json `
  .\runtime\archive\dashboard-archive-2099-01-01.json
```
