/* ============================================================================
   Mail Code Dashboard · 设计系统运行时 v1
   ----------------------------------------------------------------------------
   只包含「视觉状态」的行为：主题、按钮忙态、通知、对话框、菜单翻转、相对时间。
   不包含任何业务逻辑、接口调用或存储读写（主题偏好除外）。

   以传统脚本方式引入，暴露为 window.DS：
     <script src="/assets/design-system.js"></script>
   ========================================================================== */

(function (global) {
  "use strict";

  /* 与主收件台共用同一个键，两个页面的主题偏好必须一致。 */
  var THEME_KEY = "mail-code-dashboard-theme-v1";
  var THEME_ORDER = ["auto", "light", "dark"];
  var THEME_LABEL = { auto: "跟随系统", light: "浅色", dark: "深色" };
  var THEME_ICON = { auto: "◐", light: "○", dark: "●" };

  function readStoredTheme() {
    try {
      var value = global.localStorage.getItem(THEME_KEY);
      return THEME_ORDER.indexOf(value) >= 0 ? value : "auto";
    } catch (error) {
      /* 隐私模式下 localStorage 可能抛错，退回跟随系统。 */
      return "auto";
    }
  }

  function currentTheme() {
    var value = document.documentElement.dataset.theme;
    return THEME_ORDER.indexOf(value) >= 0 ? value : "auto";
  }

  /* 应用主题并同步顶栏按钮与设置面板里的三态分段控件。 */
  function applyTheme(theme) {
    var next = THEME_ORDER.indexOf(theme) >= 0 ? theme : "auto";
    document.documentElement.dataset.theme = next;
    try {
      global.localStorage.setItem(THEME_KEY, next);
    } catch (error) {
      /* 存不下就只在本次会话生效。 */
    }

    document.querySelectorAll("[data-theme-icon]").forEach(function (node) {
      node.textContent = THEME_ICON[next];
    });
    document.querySelectorAll("[data-theme-toggle]").forEach(function (node) {
      node.title = "主题：" + THEME_LABEL[next];
    });
    document.querySelectorAll("[data-theme-value]").forEach(function (node) {
      node.setAttribute(
        "aria-pressed",
        String(node.dataset.themeValue === next)
      );
    });
    return next;
  }

  function cycleTheme() {
    var order = ["auto", "light", "dark"];
    var index = order.indexOf(currentTheme());
    return applyTheme(order[(index + 1) % order.length]);
  }

  /* 绑定 [data-theme-toggle] 与 [data-theme-value]，并套用已保存的偏好。
     页面只需要在 DOM 就绪后调一次。 */
  function initTheme() {
    document.addEventListener("click", function (event) {
      var toggle = event.target.closest("[data-theme-toggle]");
      if (toggle) {
        cycleTheme();
        return;
      }
      var option = event.target.closest("[data-theme-value]");
      if (option) applyTheme(option.dataset.themeValue);
    });
    return applyTheme(readStoredTheme());
  }

  /* --------------------------------------------------------------------------
     通知
     容器需要写成 <div class="toast" role="status" aria-live="polite"></div>，
     缺少时这里会补建一个，保证脚本调用不会静默失败。
     ------------------------------------------------------------------------ */
  function toastContainer() {
    var node = document.querySelector(".toast");
    if (!node) {
      node = document.createElement("div");
      node.className = "toast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      document.body.appendChild(node);
    }
    return node;
  }

  function toast(tone, title, detail) {
    var notice = document.createElement("div");
    notice.className = "notice";
    notice.dataset.tone = tone || "info";

    var strong = document.createElement("strong");
    strong.textContent = String(title == null ? "" : title);
    notice.appendChild(strong);

    if (detail) {
      var span = document.createElement("span");
      span.textContent = String(detail);
      notice.appendChild(span);
    }

    toastContainer().appendChild(notice);
    global.setTimeout(function () {
      notice.remove();
    }, tone === "error" || tone === "danger" ? 6000 : 3200);
    return notice;
  }

  /* --------------------------------------------------------------------------
     按钮忙态
     文字换成 spinner，宽度不变，期间禁用。任何会发请求的按钮都要走这里，
     不要手工改按钮文案 —— 那会让工具条在请求期间抖动。
     ------------------------------------------------------------------------ */
  async function withBusy(button, task) {
    if (!button) return task();
    var wasDisabled = button.disabled;
    button.dataset.busy = "true";
    button.disabled = true;
    try {
      return await task();
    } finally {
      delete button.dataset.busy;
      button.disabled = wasDisabled;
    }
  }

  /* --------------------------------------------------------------------------
     对话框：一律原生 <dialog>
     ------------------------------------------------------------------------ */
  function openDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  /* 绑定 [data-dialog-close] 按钮，省掉每个页面重复写关闭处理。 */
  function initDialogs() {
    document.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-dialog-close]");
      if (trigger) closeDialog(trigger.closest("dialog"));
    });
  }

  /* --------------------------------------------------------------------------
     行内菜单定位
     以视口坐标放置，贴近右下角时向上 / 向左翻转，始终留在视口内。
     ------------------------------------------------------------------------ */
  function placeMenu(menu, anchor) {
    if (!menu || !anchor) return;
    menu.classList.add("menu-floating");
    menu.dataset.open = "true";
    menu.style.left = "0px";
    menu.style.top = "0px";

    var rect = anchor.getBoundingClientRect();
    var size = menu.getBoundingClientRect();
    var margin = 8;

    var left = rect.right - size.width;
    if (left < margin) left = margin;
    var maxLeft = global.innerWidth - size.width - margin;
    if (left > maxLeft) left = Math.max(margin, maxLeft);

    var top = rect.bottom + 4;
    if (top + size.height > global.innerHeight - margin) {
      top = rect.top - size.height - 4;
    }
    var maxTop = global.innerHeight - size.height - margin;
    if (top > maxTop) top = maxTop;
    if (top < margin) top = margin;

    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function closeMenus() {
    document.querySelectorAll(".menu[data-open='true']").forEach(function (menu) {
      menu.dataset.open = "false";
    });
  }

  /* --------------------------------------------------------------------------
     格式化
     ------------------------------------------------------------------------ */
  var UNITS = [
    [86400000, "天"],
    [3600000, "小时"],
    [60000, "分钟"]
  ];

  /* 列表里的时间一律相对格式：绝对时间太长，会挤掉主题列。
     完整时间放到 title 里。 */
  function relativeTime(value, now) {
    if (!value) return "";
    var time = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(time.getTime())) return "";
    var base = now instanceof Date ? now.getTime() : Date.now();
    var diff = base - time.getTime();
    if (diff < 0) return "刚刚";
    for (var i = 0; i < UNITS.length; i += 1) {
      var step = UNITS[i][0];
      if (diff >= step) return Math.floor(diff / step) + UNITS[i][1] + "前";
    }
    return diff >= 10000 ? Math.floor(diff / 1000) + "秒前" : "刚刚";
  }

  function absoluteTime(value) {
    if (!value) return "";
    var time = value instanceof Date ? value : new Date(value);
    return Number.isNaN(time.getTime()) ? "" : time.toLocaleString("zh-CN");
  }

  /* 搜索框必须防抖，否则每次按键都触发一次全量重渲染。 */
  function debounce(fn, wait) {
    var timer = 0;
    return function () {
      var args = arguments;
      var self = this;
      global.clearTimeout(timer);
      timer = global.setTimeout(function () {
        fn.apply(self, args);
      }, wait == null ? 160 : wait);
    };
  }

  global.DS = {
    THEME_KEY: THEME_KEY,
    initTheme: initTheme,
    applyTheme: applyTheme,
    cycleTheme: cycleTheme,
    currentTheme: currentTheme,
    toast: toast,
    withBusy: withBusy,
    openDialog: openDialog,
    closeDialog: closeDialog,
    initDialogs: initDialogs,
    placeMenu: placeMenu,
    closeMenus: closeMenus,
    relativeTime: relativeTime,
    absoluteTime: absoluteTime,
    debounce: debounce
  };
})(window);
