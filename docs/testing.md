# 开发与测试

## 环境

- Node.js ≥ 22.13，推荐 Node.js 24。
- Python 3 用于扩展结构校验和静态服务器测试。
- Docker 用于镜像构建与容器集成测试。

所有自动化测试应使用临时目录、合成账号和邮件，不读取实际运行环境的凭证或状态。

## 安装与单元测试

```sh
npm ci
npm test
node --test extensions/chrome-cookie-bridge/test/background.test.mjs
python extensions/chrome-cookie-bridge/scripts/validate_extension.py
node scripts/check-distribution.mjs
```

覆盖账号隔离、Cookie 身份核验、分发原子性、限时分享与旧永久 Token 兼容、到期边界、会话撤销、访问权限、邮件匹配、后台任务、状态持久化和页面交互。分享链接另行验证片段清除、自动登录、失效时不回退到其他邮箱，以及凭证不写入浏览器存储。

## 容器测试

```sh
docker build --target test -t mail-dashboard-unit .
docker run --rm mail-dashboard-unit
docker build --target runtime -t mail-dashboard-test .
node scripts/smoke-hosted-container.mjs mail-dashboard-test
```

容器集成测试创建一次性数据卷和随机测试凭证，验证初始化防覆盖、多账号存储、重启后数据保留以及授权撤销。测试不发布端口、不连接真实 Apple 或 IMAP，结束时清理测试资源。

## 持续集成

GitHub Actions 包含 Windows / Ubuntu 与 Node.js 22.13 / 24 测试矩阵，以及默认 Node.js 24 Docker 构建与集成测试。平台专属功能在对应平台验证。

## 发布检查

- 运行单元测试、扩展校验和源码分发检查。
- 确认仓库和镜像不含数据卷、凭证、备份、运行日志或个人环境说明。
- 对候选镜像执行容器集成测试。
- 使用独立测试账号验证目标环境的域名、HTTPS、Cookie 核验和 IMAP 连通性。
- 备份应用数据和主密钥，按部署指南升级并核对健康状态。
