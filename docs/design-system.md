# 信屿 MailIsle · 单机入口设计系统

本文记录 `server.mjs` 与 `mail-code-dashboard.html` 使用的既有组件及兼容约定。当前多账号管理后台、收件页及品牌展示遵循 [界面与品牌设计约定](interface-design.md)，固定采用浅色主题；本文中的主题切换和暗色令牌仅适用于单机入口，不用于服务器页面。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `mail-code-dashboard/assets/design-system.css` | 单机入口的令牌 + 基础样式 + 通用组件 |
| `mail-code-dashboard/assets/design-system.js` | 视觉状态的行为：主题、忙态、通知、对话框、菜单定位、相对时间 |
| `mail-code-dashboard/design-system.html` | 活样式指南，`/design-system.html` 可访问，改完在这里肉眼验收 |
| `mail-code-dashboard/test/design-system.test.mjs` | 令牌漂移与结构守卫 |

使用这套既有组件的单机页面以这三行引入：

```html
<html lang="zh-CN" data-theme="auto">
<link rel="stylesheet" href="/assets/design-system.css" />
<script src="/assets/design-system.js"></script>
```

`data-theme="auto"` 必须写在 `<html>` 上，否则首帧会闪一下浅色。

## 五条硬规则

1. **页面不写字面量。** 颜色、字号、间距、圆角、阴影、层级一律用令牌。测试会检查样式指南里没有 `#rrggbb` 和 `rgba(`；新页面应遵守同一条。
2. **一屏最多一个 `.btn-primary`。** 破坏性操作用 `.btn-danger`（透明底、红字），并收进溢出菜单。原来一行五个同等抢眼的按钮里最红的是删除，这是反的。
3. **列表行高 52px 不可协商。** 700 条库存下的可用性来自密度。要加信息就压缩或收进「更多」，不是加高行。
4. **窄视口收窄，不横向滚。** 次要列用 `.hide-md` / `.hide-sm` 藏掉，列宽用 `--grid-cols-md` / `--grid-cols-sm` 换掉。
5. **弹窗只用原生 `<dialog>` + `showModal()`。** 焦点陷阱、Esc、遮罩由浏览器提供，自己搭 div 一定会漏可访问性。

## 令牌

### 颜色语义

| 语义 | 令牌 | 用途 |
| --- | --- | --- |
| 品牌 | `--brand` `--brand-hover` `--brand-soft` | 主操作、选中态、行左侧强调条。全站唯一的高饱和色 |
| 成功 | `--ok` `--ok-soft` | 已完成、Trial Link 一类的终态 |
| 警告 | `--warn` `--warn-soft` | 待处理、Confirm Link、搜索高亮底色 |
| 危险 | `--danger` `--danger-soft` | 破坏性操作、失败 |
| 信息 | `--info` `--info-soft` | 链接、未使用、进行中 |
| 中性 | `--idle` `--idle-soft` | 无数据、垃圾箱、未开始 |

`-soft` 只用于标签底色和悬停底色，不用于大面积填充。

表面层级从低到高：`--bg`（页面）→ `--surface`（面板、行）→ `--surface-2`（行悬停、对话框脚）→ `--surface-hover`（控件悬停）；`--surface-sunken` 是下沉件（搜索框、胶囊、分段控件底）。分隔线 `--line`，需要更强对比时 `--line-strong`。

文字三级：`--text` → `--text-muted`（次要）→ `--text-faint`（辅助、表头、占位）。

### 尺度

字号只有 `--text-xs/sm/md/lg/xl`（11/12/13/15/18），间距只有 `--sp-1..6`（4/8/12/16/20/24）。不要在中间插值。

控件高度只有三档：`--control-h`（32，按钮与输入）、`--control-h-sm`（26，行内小按钮、分段项）、`--appbar-h` / `--row-height`（52）。

层级用 `--z-appbar`(20) / `--z-menu`(30) / `--z-toast`(60)，不写裸数字。

### 暗色

`:root[data-theme="dark"]` 与「`auto` + 系统深色」各覆盖一份令牌，两份必须逐条相同——测试会比对。这是唯一允许的重复，因为 CSS 没法让媒体查询复用一份声明块而不引入构建步骤。


## 组件

### 骨架

`.appbar`（品牌 `.brand` + `.brand-mark`、状态位 `.appbar-status` + `.status-dot[data-state]`、右侧 `.appbar-actions`）→ `.app-main` → 若干 `.panel` → `.toolbar`。

顶栏状态位是「色点 + 短句」，长内容截断并放进 `title`，不允许在顶栏铺开长陈述句。

### 密集列表

`.list-head` 与 `.row` 共用容器上声明的列宽变量，末列必须固定宽度：

```css
.wm-list {
  --grid-cols: minmax(200px, 1.6fr) 132px minmax(0, 1.4fr) 96px 108px;
  --grid-cols-md: minmax(180px, 1.6fr) 132px minmax(0, 1.4fr) 108px;
  --grid-cols-sm: 1fr auto;
}
```

两个网格必须用同一份定义，否则 `auto` 在表头和数据行里解析出不同宽度，列会错位。

单元格用 `.cell`（`min-width: 0`，截断的前提）+ `.truncate` / `.cell-strong` / `.cell-muted` / `.cell-actions`。需要强调的行用 `data-marked="true"`（左侧 2px 色条，颜色可用 `--row-accent` 覆盖），不要整行换底色。

### 状态标签

`.tag[data-tone="ok|warn|danger|info|neutral"]`，带色点。**tone 是语义，不是业务名**，业务态到 tone 的映射写在页面里：

```css
.tag[data-status="trial"]   { /* 用 data-tone="ok" */ }
.tag[data-status="confirm"] { /* 用 data-tone="warn" */ }
.tag[data-status="none"]    { /* 用 data-tone="neutral" */ }
```

数量、时间一类无语义的胶囊用 `.chip`。验证码、链接码用 `.code-value`（等宽 + 等宽数字，整列纵向对齐便于扫读），空值加 `data-empty="true"`。

### 其他

`.stats` / `.stat`（列数由 `--stat-cols` 控制，`data-tone` 给数值上色）、`.tabs` / `.tab`、`.collapsible`、`.pagination`、`.progress`（不确定进度）、`.skeleton-row`、`.empty`、`.menu` / `.menu-floating`、`dialog` + `.dialog-head/body/foot`、`.toast` / `.notice[data-tone]`、`.field` / `.field-grid` / `.search` / `.segmented`。

全部形态见 `/design-system.html`。

## 运行时 `window.DS`

| 接口 | 约定 |
| --- | --- |
| `DS.initTheme()` | 绑定 `[data-theme-toggle]`、`[data-theme-value]`，套用已存偏好。页面只调一次 |
| `DS.withBusy(button, task)` | 所有发请求的按钮都必须走它。文字换 spinner、宽度不变、期间禁用。手改按钮文案会让工具条抖动 |
| `DS.toast(tone, title, detail?)` | `ok` / `warn` / `error` / `info`。容器需 `role="status" aria-live="polite"`，缺失时自动补建 |
| `DS.openDialog / closeDialog / initDialogs` | 原生 `<dialog>` 封装，`initDialogs()` 接管 `[data-dialog-close]` |
| `DS.placeMenu(menu, anchor)` | 视口坐标定位，贴边时向上/向左翻转并夹在视口内 |
| `DS.relativeTime(v)` / `DS.absoluteTime(v)` | 列表里的时间一律相对格式，完整时间放 `title` |
| `DS.debounce(fn, 160)` | 搜索框必须防抖，否则每次按键触发全量重渲染 |

运行时只管视觉状态，不含业务逻辑、接口调用和存储读写（主题偏好除外）。

## 可访问性基线

新页面必须满足，缺一条算未完成：

- 首元素是 `.skip-link`；主区有对应 `id`。
- 图标按钮有 `aria-label`；行内操作的标签带上具体邮箱地址。
- 标签页 `role="tablist"` + `aria-selected`，支持左右方向键；`/` 聚焦搜索框。
- 焦点可见：不覆盖全局 `:focus-visible` 描边。
- `prefers-reduced-motion` 下动画归零（设计系统已处理，页面不要再加不受控动画）。
- 表单控件有关联 `<label>`。

## 守卫

`npm test` 里的 `test/design-system.test.mjs` 检查：

1. 深色令牌不能引入浅色没有的名字；
2. 显式深色与跟随系统深色两份副本逐条相同；
3. 收件台页面样式不重定义根令牌、主题、颜色字面量或裸的共享组件选择器；
4. 样式指南只引用设计系统，自身不含颜色字面量；
5. `window.DS` 导出页面依赖的全部接口；
6. 主题存储键在收件台与运行时里是同一个。

`test/server-security.test.mjs` 另外验证设计系统、Dashboard CSS 与五个浏览器模块均在精确静态白名单内、Content-Type 正确，且 `/assets/../server.mjs` 一类穿越仍是 404。`test/test_browser_smoke_support.py` 会真正启动烟测静态服务器，证明它与生产白名单、MIME、`no-store` 和安全响应头一致。

## 页面集成

- `mail-code-dashboard.html` 依次加载 `design-system.css` 与 `dashboard.css`，不再包含内联 `<style>`。
- `dashboard.css` 只保留邮箱行、领取记录、迁移卡、邮件预览和局部响应式布局；按钮、面板、列表、统计、对话框等通用规则全部来自设计系统。
- 库存网格在 `.inventory-panel` 上定义 `--grid-cols`、`--grid-cols-md` 与 `--grid-cols-sm`，桌面、1100px 和 640px 三档均由同一组共享列表规则计算。
- `.message-*`、`.claim-*`、`.migration-*` 与 `.mail-html-frame` 是单页业务样式，故意留在 `dashboard.css`，不放大通用层。
