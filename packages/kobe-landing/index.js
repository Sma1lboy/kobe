// EN / 中文 — one page, two language versions. Terminal-mock content
// (commands, branch names, TUI chrome) deliberately stays English.
var KOBE_I18N = (function () {
  var zh = {
    'meta.title': 'Rove — 把编码代理跑成一张图，终端原生',
    'meta.desc': 'Rove 是本地优先的图工程 TUI：把多个 AI 编码代理跑成一张由隔离尝试组成的图——git worktree、托管引擎会话、显式结果上报——最后合入赢家。',
    'nav.workflow': '--原语', 'nav.install': '--安装', 'nav.plugins': '--插件', 'nav.themes': '--主题', 'nav.changelog': '--更新日志',
    'hero.kicker': '提示词工程 → 上下文工程 → <span class="acc">图工程</span>',
    'hero.title': '装在你 shell 里的 agent <span class="acc">多路复用器</span>。',
    'hero.sub': '一个代理是一场对话，五个同时跑就是一张图：节点是隔离的尝试——git worktree + 引擎会话 + 分支——边是依赖，门是你的判断。Rove 是这张图的终端原生运行时。',
    'hero.getStarted': '快速上手 ↗',
    'hero.requirements': '支持 macOS 和 Linux（Windows 走 WSL）。需要 Bun ≥ 1.3.11，以及 PATH 上任意一个引擎 CLI。',
    'copy.hint': '点击复制', 'copy.done': '✓ 已复制',
    'workspace.equation': '一个节点 =', 'workspace.sessions': '托管引擎会话',
    's1.no': '1.0 · 扇出', 's1.title': '一条 prompt 变成 N 个隔离的尝试。',
    's1.body': '扇出是第一个原语，而隔离正是重点。Rove 为每个尝试建独立的 git worktree 和分支，运行你指定的引擎——claude、codex、copilot、kimi，或你自己的命令。独立节点，没有共享状态，代理之间互不碰文件。',
    's1.ownCmd': '你自己的命令',
    's2.no': '2.0 · 监督', 's2.title': '沉默不是一种状态。尝试要报告。',
    's2.body': '在一排终端机群里，安静的代理可能在思考，也可能已经挂了。所以在 Rove 里，每个尝试结束时都显式上报结果——succeeded 或 failed——编排代理可以阻塞等待整批尝试出结果。代理编排代理，有真正的完成语义。',
    's3.no': '3.0 · 观察', 's3.title': '读会话本身，不刮终端屏幕。',
    's3.body': 'Rove 直接读每个引擎自己的会话数据——历史、token、上下文——而不是抓取终端文本。每个会话都运行在代码所在机器的 Hosted PTY 里、由 daemon 托管：退出 TUI、断开 SSH，这张图继续跑。从任何地方重新接上。',
    's3.body2': '而且是你的真实机器：真实的依赖、服务、凭证和构建缓存。代理跑通的对你也跑通。',
    's4.no': '4.0 · 扇入', 's4.title': '比较尝试，合入赢家。',
    's4.body': '扇入是一道人工门。拉一份所有尝试的只读快照——分支、diff 统计、运行状态——并排审阅，合入你满意的分支，归档其余。一次尝试是掷硬币——N 次是选择。',
    'install.title': '在你代码所在的地方跑起来。',
    'install.body': '笔记本、devbox、VPS，或任何能 SSH 上去的机器。没有浏览器、没有 VNC、没有桌面应用。优化唯一重要的指标：你每小时注意力换来的已合并代码。',
    'install.npm': '从 npm 安装 ↗', 'install.star': '去 GitHub 点个 Star ↗',
    'final.line': '所有支流终会汇合。判断权在你手里。',
    'footer.tagline': '终端原生的编码代理图工程。',
    'footer.colophon': '用 Bun、OpenTUI 和 React 构建。字体为 Fraunces、DM Sans 与 JetBrains Mono。MIT 许可。',
    'footer.plugins': '插件', 'footer.changelog': '更新日志', 'footer.keybindings': '快捷键',
  };
  var en = {
    'meta.title': 'Rove — run coding agents as a graph, terminal-native',
    'meta.desc': 'Rove is a local-first TUI for graph engineering: run many AI coding agents as a graph of isolated attempts — git worktrees, hosted engine sessions, explicit reports — and merge the winner.',
    'nav.workflow': '--primitives', 'nav.install': '--install', 'nav.plugins': '--plugins', 'nav.themes': '--themes', 'nav.changelog': '--changelog',
    'hero.kicker': 'prompt engineering → context engineering → <span class="acc">graph engineering</span>',
    'hero.title': 'The agent <span class="acc">multiplexer</span> in your shell.',
    'hero.sub': 'One agent is a conversation. Five at once are a graph: nodes are isolated attempts — git worktree + engine session + branch — edges are dependencies, and the gates are your judgment. Rove is the terminal-native runtime for that graph.',
    'hero.getStarted': 'Get started ↗',
    'hero.requirements': 'Runs on macOS & Linux (Windows via WSL). Requires Bun ≥ 1.3.11 and one engine CLI on your PATH.',
    'copy.hint': 'click to copy', 'copy.done': '✓ copied',
    'workspace.equation': 'one node =', 'workspace.sessions': 'hosted engine session',
    's1.no': '1.0 · FAN OUT', 's1.title': 'One prompt becomes N isolated attempts.',
    's1.body': 'Fan-out is the first primitive, and isolation is the point. Rove spawns every attempt in its own git worktree on its own branch, running whichever engine you point it at — claude, codex, copilot, kimi, or your own command. Independent nodes, no shared state, no agents stepping on each other\'s files.',
    's1.ownCmd': 'your own command',
    's2.no': '2.0 · SUPERVISE', 's2.title': 'Silence is not a status. Attempts report.',
    's2.body': 'In a fleet of terminals, a quiet agent could be thinking or could be dead. So in Rove every attempt ends by reporting an explicit outcome — succeeded or failed — and an orchestrating agent can block until the whole fleet resolves. Agents orchestrating agents, with real completion semantics.',
    's3.no': '3.0 · OBSERVE', 's3.title': 'Read the session, never scrape the screen.',
    's3.body': 'Rove reads each engine\'s own session data — history, tokens, context — instead of scraping terminal text. And every session lives in a hosted PTY behind the daemon, on the machine where your code lives: quit the TUI, drop SSH, the graph keeps running. Reattach from anywhere.',
    's3.body2': 'And it\'s your real machine: real dependencies, services, credentials, build cache. What passes for the agent passes for you.',
    's4.no': '4.0 · FAN IN', 's4.title': 'Compare the attempts. Merge the winner.',
    's4.body': 'Fan-in is a human gate. Pull a read-only snapshot of every attempt — branch, diffstat, running state — review them side by side, merge the branch you like, archive the rest. One attempt is a coin flip — N is a choice.',
    'install.title': 'Spin it up where your code lives.',
    'install.body': 'Your laptop, a devbox, a VPS, or any machine you can SSH into. No browser, no VNC, no desktop app. Optimize the one metric that matters: merged code per hour of your attention.',
    'install.npm': 'Install from npm ↗', 'install.star': 'Star on GitHub ↗',
    'final.line': 'Every stream converges. You keep the judgment.',
    'footer.tagline': 'graph engineering for coding agents, terminal-native.',
    'footer.colophon': 'Built with Bun, OpenTUI and React. Set in Fraunces, DM Sans and JetBrains Mono. MIT licensed.',
    'footer.plugins': 'plugins', 'footer.changelog': 'changelog', 'footer.keybindings': 'keybindings',
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
  apply(); // first paint: honors ?lang= / stored pref / browser language

  return { t: t };
})();

// copy-to-clipboard for the install command
(function () {
  var btn = document.getElementById('copyBtn');
  var label = document.getElementById('copyLabel');
  var timer;
  btn.addEventListener('click', function () {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText('bun install -g @sma1lboy/rove');
    } catch (e) {}
    label.textContent = KOBE_I18N.t('copy.done');
    clearTimeout(timer);
    timer = setTimeout(function () { label.textContent = KOBE_I18N.t('copy.hint'); }, 1800);
  });
})();

// live GitHub star count (cache for instant first paint, refresh each load, graceful fallback)
(function () {
  var el = document.getElementById('starCount');
  if (!el) return;
  function render(n) {
    el.textContent = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
  }
  var CACHE_KEY = 'kobe_stars';
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && typeof cached.n === 'number') render(cached.n);
  } catch (e) {}
  fetch('https://api.github.com/repos/Sma1lboy/rove')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || typeof d.stargazers_count !== 'number') return;
      render(d.stargazers_count);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ n: d.stargazers_count })); } catch (e) {}
    })
    .catch(function () { if (el.textContent === '–') el.textContent = '☆'; });
})();

// engine selector → updates the stage-1 fan-out (vendor flag + spawned worktree lanes)
(function () {
  var branchMap = {
    'claude': 'claude', 'codex': 'codex', 'copilot': 'copilot',
    'kimi': 'kimi', 'your own command': 'my-cli',
  };
  var engineEl = document.getElementById('fanEngineName');
  var linesEl = document.getElementById('fanLines');
  var pills = document.querySelectorAll('.engine-pill');
  if (!engineEl || !linesEl) return;

  function render(engine) {
    var slug = branchMap[engine] || engine;
    engineEl.textContent = engine === 'your own command' ? 'my-cli' : engine;
    var pad = function (s) { return (s + '              ').slice(0, 16); };
    linesEl.innerHTML = ['a', 'b', 'c'].map(function (s) {
      return '<span class="ok">●</span> ' + pad('kobe/' + slug + '-' + s) + '<span class="d">running</span>';
    }).join('\n');
  }

  pills.forEach(function (pill) {
    pill.addEventListener('click', function () {
      pills.forEach(function (p) { p.setAttribute('data-active', 'false'); });
      pill.setAttribute('data-active', 'true');
      render(pill.getAttribute('data-engine'));
    });
  });
  render('claude');
})();
