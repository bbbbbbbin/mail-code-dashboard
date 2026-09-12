# 上传前说明

## 上传范围

新建私有仓库 `mail-code-dashboard`，上传本项目源码。
项目包含收件台、后台隐藏邮箱生成、库存与领取 API、转发收件和 Chrome Cookie 扩展。
使用全新 Git 历史，不包含旧工具集历史和额外的业务状态页。

## 本地检查

```powershell
npm ci
npm test
node scripts/check-distribution.mjs
node --test extensions/chrome-cookie-bridge/test/background.test.mjs
```

`node_modules`、`runtime` 内的真实数据、日志、导出文件、Cookie、API Key 和邮箱密码都不上传。
若使用网页上传，先解压源码 ZIP，再上传其中的源码文件及目录，保留目录结构；不要把 ZIP 本身作为唯一项目文件。

## 登录后

确认 GitHub 当前登录账号，创建 **Private** 仓库 `mail-code-dashboard`，再上传源码或推送本地 `main` 分支。
推送前检查 GitHub 目标地址，保持原工具集仓库不变。

若本机已配置 GitHub CLI，可在本项目目录中执行：

```powershell
gh auth login
gh repo create mail-code-dashboard --private --source . --remote origin --push
```

本地验证涵盖未打开任何页面时的后台执行、重启冷却时间、停止开关、重入去重、失败退避和两个实例的状态隔离。
后台演示使用合成邮箱；真实 iCloud 的成功生成仍取决于对应账号登录态、网络和 Apple 配额。
