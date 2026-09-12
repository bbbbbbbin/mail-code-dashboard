# 服务器版验收记录

## 本地已完成

- 多账号独立库存、生成队列、收件配置和核验绑定；总览合并展示，账号有不同颜色标识。
- 管理员密码、程序读取密钥、Chrome Cookie 同步密钥、单邮箱 Token 分离。
- 仅明确分发创建 Token，默认永久；批量操作原子提交，撤销与重置即时影响旧会话。
- 后台按账号生成与收件扫描，不依赖页面保持打开。异常生成不静默重试。
- IMAP 精确收件头匹配、分发时点过滤，正文文本展示，刷新保留展开状态。
- HTTPS 双域名、加密配置、独立主密钥、非 root 只读容器、持久化卷、初始化防覆盖。
- Chrome 扩展 1.3.0 支持服务器模式，保留旧本机模式。

## 验证方式

所有账号、Cookie、邮件和 Token 均为合成数据；未连接 4173 / 4174 或真实 Apple / IMAP。

- Windows Node：370 项完整测试（含服务器 DOM 单元测试）通过。
- Linux Docker / Node 22.23.0：357 项测试通过，13 项 Windows 平台专用测试按原功能边界跳过。
- 扩展：22 项后台测试、Python 结构校验通过。
- 浏览器：管理员登录、双账号列表、明确分发、Token 单邮箱收件、正文脚本文本展示、撤销后旧会话失效；管理页控制台未出现错误。
- 容器集成：初始化、再次初始化不覆盖、两账号各自库存、容器重启、原永久 Token 再登录、撤销后旧 Token 与旧会话失效。
- Compose 配置解析通过，源码分发/凭证模式扫描通过，依赖审计未报告已知漏洞（运行时点结果，不是永久安全保证）。

## 可复现命令

```sh
npm ci
npm test
node --test extensions/chrome-cookie-bridge/test/background.test.mjs
python extensions/chrome-cookie-bridge/scripts/validate_extension.py
node scripts/check-distribution.mjs
docker build --target test -t mail-dashboard-unit .
docker run --rm mail-dashboard-unit
docker build --target runtime -t mail-dashboard-test .
node scripts/smoke-hosted-container.mjs mail-dashboard-test
```

默认镜像为 Node 24。此次本机拉取 Node 24 被 Docker Hub 网络故障中断，改用已有官方 Node 22.23.0 镜像完成 Linux 验证：构建时附加 `--build-arg NODE_IMAGE=node:22-bookworm-slim`。这不等于默认 Node 24 镜像已完成本机验证；GitHub CI 设置了 Node 22 / 24、Windows / Ubuntu 及默认 Docker 构建。

## 尚未执行

- GitHub CLI 认证后的发布及远端 CI 确认。
- Linux 服务器真实域名、证书、Apple 账号和转发 IMAP 的联调。
- 本机 4173 / 4174 数据迁移。必须按 [迁移清单](server-migration.md) 单独备份、预演和切换；此阶段不动旧服务。
