// EN / 中文 — same mechanism as the home page (data-i18n + localStorage).
// Terminal-mock content (branch names, TUI chrome) deliberately stays English.
var KOBE_I18N = (function () {
  var zh = {
    'meta.title': 'Rove — 主题',
    'meta.desc': '每个内置 Rove 主题都由它真实的配色文件渲染，另附如何编写并发布你自己的主题。一个主题就是一个 JSON 文件，没有需要挤进去的注册表。',
    'nav.workflow': '--原语', 'nav.install': '--安装', 'nav.plugins': '--插件', 'nav.themes': '--主题', 'nav.changelog': '--更新日志',
    'head.kicker': '外观',
    'head.title': '内置三套，<span class="acc">另外十套</span>一条命令。',
    'head.lede': '下面每一块面板都由真实的主题文件绘制——就是 Rove 启动时加载的那份 JSON，不是谁手工调色的截图。在 <code>设置 → General → Theme</code> 里挑内置的三套之一，其余的一条命令装上，或者自己写——一个主题就是一个 JSON 文件，没有需要挤进去的注册表。',
    'bundled.no': '1.0 · 内置',
    'bundled.title': '随 Rove 一起发布。',
    'bundled.body': 'Rove 刻意把内置的一套保持得很小——用 <code>ctrl+,</code> 打开设置直接选，无需安装。每个预览都用该主题自己的色槽绘制侧边栏、选中的任务和一段 diff，所以你看到的就是实际会得到的对比度。每个主题同时定义了浅色模式，预览展示的是深色。',
    'tag.default': '默认',
    'note.claude': '暖石墨配陶土色——Rove 自己的身份色，与 Claude Code 的配色一致。',
    'note.conductor': '近黑与近白。没有色相来跟你的 diff 抢注意力——投屏时首选这套。',
    'note.dracula': '大家早就有肌肉记忆的那套。这里饱和度最高的一组。',
    'note.nord': '北极蓝灰，刻意压低对比。长时间工作最不累的选择。',
    'note.opencode': '中性炭灰加沙色强调色——从 opencode 过来会觉得眼熟。',
    'note.osaka': '深玉底色配薄荷信号色。最有主张的一套，运行指示也最响。',
    'note.tokyonight': '靛蓝夜色配珊瑚强调色。和你 nvim 里大概已经在用的 tokyonight 成套。',
    'note.gruvbox': '复古律动：暖棕底色配一记信号橙。暖色系里对比最强的一套，也是多数人说「终端配色」时想到的那个。',
    'note.catppuccin': '冷灰底上的柔和粉彩——藕紫作标志色，没有一处喧哗。深色用 Mocha，浅色用 Latte。',
    'note.rosepine': '近黑的梅色底上低饱和的鸢尾与玫瑰。安静但不发灰；浅色侧是 Dawn。',
    'note.everforest': '去饱和的森林绿，为暖色底上的长时间工作调过。',
    'note.kanagawa': '取自葛饰北斋的浪——墨蓝压在墨黑上，浅色侧是 lotus。',
    'note.solarized': '2011 年那个开创了精确终端配色的原版。深浅两侧共用同一组强调色。',
    'dl.no': '2.0 · 可下载',
    'dl.title': '另外十套，一条命令的距离。',
    'dl.body': '这些不装在二进制里，而是作为纯 JSON 托管在这——主题本来就只是这个。复制命令、运行、重启 Rove。其中几套在早先版本里是内置的；除了存放位置，它们没有任何变化。',
    'card.copy': '复制', 'card.copied': '已复制',
    'write.no': '3.0 · 动手写',
    'write.title': '一个主题就是一个 JSON 文件。',
    'write.body': '把任意 <code>*.json</code> 丢进 <code>~/.rove/themes/</code>，下次启动就出现在选择器里。取和内置主题同名，你的那份优先。也不必填满所有色槽——缺失的会向下回落（<code>borderActive</code> → <code>border</code> → <code>text</code>），所以十几行就已经是一套可用的主题。',
    'write.body2': '<code>defs</code> 是可选的命名色板，色槽可以按名字引用它。色槽的值可以是 hex 字符串、<code>defs</code> 的键，或者一个 <code>{ dark, light }</code> 对——用对偶形式时两边都必填。<code>$schema</code> 那行的作用是让编辑器给你自动补全。',
    'pub.no': '4.0 · 发布',
    'pub.title': '分享一个 URL。这就是全部的注册表。',
    'pub.body': '没有提交队列，也没有清单文件要写。安装走的是 HTTPS 读取原始文件，所以任何你能链接到的地方都能装——一个仓库、一个 gist、或者你自己的服务器。',
    'pub.s1': '把 JSON 提交到一个 <b>公开仓库或 gist</b>。',
    'pub.s2': '在 GitHub 上点 <b>Raw</b> 复制地址，形如 <code>raw.githubusercontent.com/&lt;你&gt;/&lt;仓库&gt;/main/&lt;主题&gt;.json</code>。',
    'pub.s3': '让别人运行 <code>rove theme add &lt;raw-url&gt;</code>。它会先校验 JSON 再写入，且不加 <code>--force</code> 不会覆盖已有主题。',
    'pub.s4': '给仓库打上 GitHub topic <code>rove-theme</code> 方便被搜到，再对本页提个 PR，就能带预览收录进来。',
    'copy.hint': '点击复制', 'copy.done': '已复制',
    'footer.tagline': '终端原生的编码代理图工程。',
    'footer.themes': '预览由每个主题真实的配色文件渲染，不是截图。',
    'footer.changelog': '更新日志', 'footer.themedocs': '主题文档', 'footer.keybindings': '快捷键',
  };
  var en = {
    'meta.title': 'Rove — themes',
    'meta.desc': "Every bundled Rove theme, rendered from its real color file — plus how to write and publish your own. A theme is one JSON file; there is no registry to get into.",
    'nav.workflow': '--primitives', 'nav.install': '--install', 'nav.plugins': '--plugins', 'nav.themes': '--themes', 'nav.changelog': '--changelog',
    'head.kicker': 'Appearance',
    'head.title': 'Three in the box, <span class="acc">ten more</span> a command away.',
    'head.lede': "Every panel below is drawn from a real theme file — the same JSON Rove loads at boot, not a screenshot someone re-tinted by hand. Pick one of the three bundled ones in <code>Settings → General → Theme</code>, install any of the rest with one command, or write your own — a theme is one JSON file, and there is no registry to get into.",
    'bundled.no': '1.0 · Bundled',
    'bundled.title': 'Ships with Rove.',
    'bundled.body': "Rove keeps its bundled set deliberately small — open Settings with <code>ctrl+,</code> and pick one, nothing to install. Each preview paints the sidebar, the selected task, and a diff with that theme's own slots, so what you see is the contrast you'll actually get. Every theme also defines a light mode; the previews show dark.",
    'tag.default': 'default',
    'note.claude': "Warm graphite and terracotta — Rove's own identity, matched to the Claude Code palette.",
    'note.conductor': 'Near-black and near-white. No hue competes with your diff — the one to reach for on a projector.',
    'note.dracula': 'The one everybody already has muscle memory for. Highest-saturation set here.',
    'note.nord': 'Arctic blue-grey, low contrast by design. The calmest option for long sessions.',
    'note.opencode': 'Neutral charcoal with a sand accent — familiar if you came from opencode.',
    'note.osaka': 'Deep jade ground with a mint signal color. The most opinionated set — and the loudest running indicator.',
    'note.tokyonight': 'Indigo night with a coral accent. Pairs with the tokyonight setup you probably already run in nvim.',
    'note.gruvbox': 'Retro groove: warm browns under a signal orange. The highest-contrast warm set, and the one most people mean by "terminal colors".',
    'note.catppuccin': 'Soft pastels on a cool grey base — mauve signature, nothing shouts. Ships Mocha for dark and Latte for light.',
    'note.rosepine': 'Low-saturation iris and rose on near-black plum. Quiet without going grey; Dawn is the light side.',
    'note.everforest': 'Desaturated forest greens, tuned for long sessions on a warm background.',
    'note.kanagawa': "Inspired by Katsushika Hokusai's wave — ink blues over sumi black, lotus for light.",
    'note.solarized': 'The 2011 original that started precision terminal palettes. Both sides share one accent set.',
    'dl.no': '2.0 · Downloadable',
    'dl.title': 'Ten more, one command away.',
    'dl.body': "These live here as plain JSON instead of inside the binary — which is all a theme ever is. Copy the command, run it, restart Rove. Several of them shipped bundled in earlier versions; nothing changed about them except where they're stored.",
    'card.copy': 'copy', 'card.copied': 'copied',
    'write.no': '3.0 · Write one',
    'write.title': 'A theme is one JSON file.',
    'write.body': "Drop any <code>*.json</code> into <code>~/.rove/themes/</code> and it appears in the picker at next boot. Name it after a bundled theme and yours wins. You don't have to fill every slot — missing ones fall through (<code>borderActive</code> → <code>border</code> → <code>text</code>), so a dozen lines is already a usable theme.",
    'write.body2': "<code>defs</code> is an optional named palette a slot can reference by name. A slot value is a hex string, a <code>defs</code> key, or a <code>{ dark, light }</code> pair — and when you use the pair form, both sides are required. The <code>$schema</code> line is what gives you autocomplete in your editor.",
    'pub.no': '4.0 · Publish',
    'pub.title': "Share a URL. That's the whole registry.",
    'pub.body': 'There is no submission queue and no manifest to write. Installation reads a raw file over HTTPS, so anything you can link to is installable — a repo, a gist, your own host.',
    'pub.s1': 'Commit the JSON to a <b>public repo or gist</b>.',
    'pub.s2': 'Hit <b>Raw</b> on GitHub and copy the URL — it looks like <code>raw.githubusercontent.com/&lt;you&gt;/&lt;repo&gt;/main/&lt;theme&gt;.json</code>.',
    'pub.s3': 'Tell people to run <code>rove theme add &lt;raw-url&gt;</code>. It validates the JSON before writing and refuses to clobber an existing theme without <code>--force</code>.',
    'pub.s4': "Tag the repo <code>rove-theme</code> on GitHub so it's findable, and open a PR against this page to get it listed with a preview.",
    'copy.hint': 'click to copy', 'copy.done': 'copied',
    'footer.tagline': 'graph engineering for coding agents, terminal-native.',
    'footer.themes': "Previews are rendered from each theme's real color file, not screenshots.",
    'footer.changelog': 'changelog', 'footer.themedocs': 'theme docs', 'footer.keybindings': 'keybindings',
  };
  var dicts = { en: en, zh: zh };
  var lang = 'en';
  try {
    var fromUrl = new URLSearchParams(location.search).get('lang');
    var stored = localStorage.getItem('kobe_lang');
    var nav = (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    lang = fromUrl === 'zh' || fromUrl === 'en' ? fromUrl : stored === 'zh' || stored === 'en' ? stored : nav;
  } catch (e) {}

  function t(key) { return dicts[lang][key] || dicts.en[key] || ''; }

  function apply() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('meta.title');
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', t('meta.desc'));
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = t(el.getAttribute('data-i18n'));
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var v = t(el.getAttribute('data-i18n-html'));
      if (v) el.innerHTML = v;
    });
    var label = document.getElementById('copyLabel');
    if (label) label.textContent = t('copy.hint');
    var toggle = document.getElementById('langToggle');
    if (toggle) toggle.textContent = lang === 'zh' ? 'EN' : '中文';
  }

  var toggleBtn = document.getElementById('langToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      lang = lang === 'zh' ? 'en' : 'zh';
      try { localStorage.setItem('kobe_lang', lang); } catch (e) {}
      apply();
    });
  }
  apply();
  return { t: t };
})();

// Per-card install commands (downloadable themes).
(function () {
  document.querySelectorAll('.tc-cmd').forEach(function (b) {
    var label = b.querySelector('.tc-copy');
    var timer;
    b.addEventListener('click', function () {
      try {
        if (navigator.clipboard) navigator.clipboard.writeText('rove theme add ' + b.getAttribute('data-cmd'));
      } catch (e) {}
      label.textContent = KOBE_I18N.t('card.copied');
      clearTimeout(timer);
      timer = setTimeout(function () { label.textContent = KOBE_I18N.t('card.copy'); }, 1600);
    });
  });
})();

(function () {
  var btn = document.getElementById('copyBtn');
  var label = document.getElementById('copyLabel');
  var timer;
  btn.addEventListener('click', function () {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText('rove theme add <raw-url>');
    } catch (e) {}
    label.textContent = KOBE_I18N.t('copy.done');
    clearTimeout(timer);
    timer = setTimeout(function () { label.textContent = KOBE_I18N.t('copy.hint'); }, 1800);
  });
})();
