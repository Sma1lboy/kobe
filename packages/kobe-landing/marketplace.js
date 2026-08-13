/* Rove marketplace — the plugin list and the hash-routed detail view.
   Loaded by plugins.html after KOBE_I18N is defined. Classic script (no module),
   so it also runs from file:// while iterating locally. */
(function () {
  var grid = document.getElementById('grid');
  var countEl = document.getElementById('count');
  var qEl = document.getElementById('q');
  var sortEl = document.getElementById('sort');
  var headSec = document.getElementById('top');
  var listSec = document.getElementById('marketplace');
  var pubSec = document.getElementById('publish');
  var detailSec = document.getElementById('detail');
  if (!grid) return;

  // The first-party plugins live in subdirectories of one repo. Subdirectories can
  // never carry a GitHub topic, so they are seeded here — and the parent repo, which
  // DOES carry the topic, is dropped from the community results below (it would be a
  // seventh card duplicating these six) after lending them its stars and push date.
  var FIRST_PARTY_REPO = 'Sma1lboy/kobe-plugins';
  var SEED = [
    { ref: 'Sma1lboy/kobe-plugins/notify', name: 'notify', owner: 'Sma1lboy', firstParty: true,
      desc: { en: 'Desktop or ntfy notifications when an agent finishes a turn or needs your input.', zh: '代理跑完一轮或需要你介入时，发桌面通知 / ntfy 推送。' } },
    { ref: 'Sma1lboy/kobe-plugins/github-start', name: 'github-start', owner: 'Sma1lboy', firstParty: true,
      desc: { en: 'Start a Rove task straight from a GitHub issue or pull request.', zh: '直接从一个 GitHub issue 或 PR 起一个 Rove 任务。' } },
    { ref: 'Sma1lboy/kobe-plugins/worktree-include', name: 'worktree-include', owner: 'Sma1lboy', firstParty: true,
      desc: { en: 'Copy gitignored files matching .worktreeinclude into every new worktree.', zh: '把 .worktreeinclude 匹配到的 gitignore 文件复制进每个新建的 worktree。' } },
    { ref: 'Sma1lboy/kobe-plugins/linear-start', name: 'linear-start', owner: 'Sma1lboy', firstParty: true,
      desc: { en: 'Pick a Linear issue (fzf) and start a Rove task on its branch with the issue as the prompt.', zh: '用 fzf 选一个 Linear issue，在它的分支上起一个 Rove 任务，issue 内容作为首条提示词。' } },
    { ref: 'Sma1lboy/kobe-plugins/lazygit', name: 'lazygit', owner: 'Sma1lboy', firstParty: true,
      desc: { en: 'Open lazygit on the task worktree as a terminal-tab pane in the running TUI.', zh: '在运行中的 TUI 里以终端 tab 面板打开任务 worktree 的 lazygit。' } },
    { ref: 'Sma1lboy/kobe-plugins/browser', name: 'browser', owner: 'Sma1lboy', firstParty: true,
      desc: { en: 'A real Chromium browser rendered as terminal cells (carbonyl) in a pane tab.', zh: '真 Chromium 以终端字符渲染（carbonyl）跑在 pane tab 里。' } },
  ];

  var items = [];
  var readmes = {}; // ref -> rendered html, or false once the fetch has failed

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function repoOf(it) { return it.ref.split('/').slice(0, 2).join('/'); }
  function subdirOf(it) { return it.ref.split('/').slice(2).join('/'); }
  function urlOf(it) {
    var sub = subdirOf(it);
    return 'https://github.com/' + repoOf(it) + (sub ? '/tree/HEAD/' + sub : '');
  }
  function descOf(it) { return typeof it.desc === 'string' ? it.desc : (it.desc[KOBE_I18N.lang()] || it.desc.en); }
  function starsOf(it) { return typeof it.stars === 'number' ? it.stars.toLocaleString() : '–'; }

  function relTime(iso) {
    if (!iso) return '';
    var days = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
    var loc = KOBE_I18N.lang() === 'zh' ? 'zh-CN' : 'en';
    try {
      var rtf = new Intl.RelativeTimeFormat(loc, { numeric: 'auto' });
      if (Math.abs(days) < 31) return rtf.format(-days, 'day');
      if (Math.abs(days) < 365) return rtf.format(-Math.round(days / 30), 'month');
      return rtf.format(-Math.round(days / 365), 'year');
    } catch (e) { return days + 'd'; }
  }

  function fromApi(r) {
    return {
      ref: r.full_name,
      // only follow github.com links, whatever the API hands back
      url: /^https:\/\/github\.com\//.test(r.html_url || '') ? r.html_url : 'https://github.com/' + r.full_name,
      name: r.name,
      owner: (r.owner && r.owner.login) || String(r.full_name || '').split('/')[0],
      desc: r.description || '',
      stars: r.stargazers_count,
      lang: r.language,
      pushed: r.pushed_at,
      created: r.created_at,
    };
  }

  var STAR_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 .25l2.06 4.18 4.61.67-3.34 3.25.79 4.6L8 10.97l-4.12 2.17.79-4.6L1.33 5.1l4.61-.67L8 .25z"/></svg>';

  // chip · language · relative push date — every part optional, no dangling separators
  function metaRow(it) {
    var parts = [];
    if (it.lang) parts.push('<span class="dot" aria-hidden="true"></span>' + esc(it.lang));
    if (it.pushed) parts.push(esc(relTime(it.pushed)));
    var chip = it.firstParty ? '<span class="tag-first">' + esc(KOBE_I18N.t('mk.firstParty')) + '</span>' : '';
    if (!chip && !parts.length) return '';
    return chip + parts.join(' <span class="sep">·</span> ');
  }

  function card(it) {
    var cmd = 'rove plugin install ' + it.ref;
    var meta = metaRow(it);
    return '<article class="card" data-ref="' + esc(it.ref) + '">' +
      '<div class="card-top">' +
        '<a class="card-name" href="#' + esc(it.ref) + '">' +
          '<span class="owner">' + esc(it.owner) + '/</span>' + esc(it.name) + '</a>' +
        '<span class="card-stars">' + STAR_SVG + starsOf(it) + '</span>' +
      '</div>' +
      '<p class="card-desc">' + esc(descOf(it)) + '</p>' +
      '<div class="card-meta">' + (meta || '&nbsp;') + '</div>' +
      '<button class="card-install" data-cmd="' + esc(cmd) + '" title="' + esc(KOBE_I18N.t('mk.copy')) + '">' +
        '<span class="ps" aria-hidden="true">$</span><span class="cmd">' + esc(cmd) + '</span></button>' +
    '</article>';
  }

  function renderList() {
    var q = (qEl.value || '').trim().toLowerCase();
    var mode = sortEl.value;
    var list = items.filter(function (it) {
      return !q || (it.ref + ' ' + descOf(it)).toLowerCase().indexOf(q) !== -1;
    });
    var key = mode === 'pushed' ? 'pushed' : mode === 'newest' ? 'created' : 'stars';
    list.sort(function (a, b) {
      var av = key === 'stars' ? (a.stars || 0) : Date.parse(a[key] || 0) || 0;
      var bv = key === 'stars' ? (b.stars || 0) : Date.parse(b[key] || 0) || 0;
      return bv - av || a.ref.localeCompare(b.ref);
    });
    countEl.textContent = list.length + ' ' + KOBE_I18N.t('mk.count');
    grid.innerHTML = list.length
      ? list.map(card).join('')
      : '<p class="empty">' + esc(KOBE_I18N.t('mk.none')) + '</p>';
  }

  // ── minimal markdown → html (headings, paragraphs, fenced code, inline code, links, lists) ──
  function mdInline(src) {
    var codes = [];
    var s = String(src).replace(/`([^`]+)`/g, function (m, c) { codes.push(c); return '\uE000' + (codes.length - 1) + '\uE001'; });
    s = esc(s);
    s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (m, text, href) {
      return /^https?:\/\//.test(href)
        ? '<a href="' + href + '" target="_blank" rel="noopener nofollow">' + text + '</a>'
        : text;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s.replace(/\uE000(\d+)\uE001/g, function (m, i) { return '<code>' + esc(codes[i]) + '</code>'; });
  }

  var BLOCK_START = /^(?:```|#{1,6}\s|\s*(?:[-*+]|\d+[.)])\s|\s*(?:---+|===+|\*\*\*+)\s*$)/;

  function md(src) {
    var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre class="md-pre"><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { out.push('<h' + h[1].length + '>' + mdInline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) { out.push('<hr class="md-hr">'); i++; continue; }
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        var ordered = /^\s*\d/.test(line), li = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]) && ordered === /^\s*\d/.test(lines[i])) {
          li.push('<li>' + mdInline(lines[i++].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')) + '</li>');
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + ' class="md-list">' + li.join('') + '</' + tag + '>');
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + mdInline(para.join(' ')) + '</p>');
    }
    return out.join('');
  }

  // ── detail view ──
  function readmeUrl(it) {
    var sub = subdirOf(it);
    return 'https://raw.githubusercontent.com/' + repoOf(it) + '/HEAD/' + (sub ? sub + '/' : '') + 'README.md';
  }

  function readmeFallback(it) {
    return '<p class="md-fail">' + esc(KOBE_I18N.t('det.readmeFail')) +
      ' <a href="' + esc(urlOf(it)) + '" target="_blank" rel="noopener">' + esc(KOBE_I18N.t('det.viewGithub')) + ' ↗</a></p>';
  }

  function loadReadme(it) {
    var host = detailSec.querySelector('.det-readme-body');
    if (!host) return;
    if (readmes[it.ref] !== undefined) {
      host.innerHTML = readmes[it.ref] || readmeFallback(it);
      return;
    }
    fetch(readmeUrl(it))
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (text) {
        readmes[it.ref] = md(text);
        if (currentRef() === it.ref) host.innerHTML = readmes[it.ref];
      })
      .catch(function () {
        readmes[it.ref] = false;
        if (currentRef() === it.ref) host.innerHTML = readmeFallback(it);
      });
  }

  function detailHtml(it) {
    var cmd = 'rove plugin install ' + it.ref;
    var facts = ['<span class="det-fact">' + STAR_SVG + starsOf(it) + '</span>'];
    if (it.lang) facts.push('<span class="det-fact"><span class="dot" aria-hidden="true"></span>' + esc(it.lang) + '</span>');
    if (it.pushed) facts.push('<span class="det-fact">' + esc(KOBE_I18N.t('det.pushed')) + ' ' + esc(relTime(it.pushed)) + '</span>');
    return '<a class="det-back" href="#">' + esc(KOBE_I18N.t('det.back')) + '</a>' +
      '<div class="det-title">' +
        '<h2 class="det-name"><span class="owner">' + esc(it.owner) + '/</span>' + esc(it.name) + '</h2>' +
        (it.firstParty ? '<span class="tag-first">' + esc(KOBE_I18N.t('mk.firstParty')) + '</span>' : '') +
      '</div>' +
      '<p class="det-desc">' + esc(descOf(it)) + '</p>' +
      '<div class="det-facts">' + facts.join('<span class="sep">·</span>') +
        '<a class="det-gh" href="' + esc(urlOf(it)) + '" target="_blank" rel="noopener">' + esc(KOBE_I18N.t('det.viewGithub')) + ' ↗</a></div>' +
      '<button class="card-install det-install" data-cmd="' + esc(cmd) + '" title="' + esc(KOBE_I18N.t('mk.copy')) + '">' +
        '<span class="ps" aria-hidden="true">$</span><span class="cmd">' + esc(cmd) + '</span></button>' +
      '<div class="det-readme"><span class="det-readme-label">README</span>' +
        '<div class="det-readme-body md"><p class="md-fail">' + esc(KOBE_I18N.t('det.readmeLoading')) + '</p></div></div>';
  }

  function currentRef() { try { return decodeURIComponent((location.hash || '').slice(1)); } catch (e) { return ''; } }

  function showList() {
    detailSec.hidden = true;
    headSec.hidden = false; listSec.hidden = false; pubSec.hidden = false;
    document.title = KOBE_I18N.t('meta.title');
    renderList();
  }

  function showDetail(it) {
    headSec.hidden = true; listSec.hidden = true; pubSec.hidden = true;
    detailSec.hidden = false;
    detailSec.innerHTML = detailHtml(it);
    document.title = it.owner + '/' + it.name + ' — Rove';
    loadReadme(it);
  }

  function route(scroll) {
    var ref = currentRef();
    var it = ref && items.filter(function (x) { return x.ref === ref; })[0];
    if (it) { showDetail(it); if (scroll) window.scrollTo(0, 0); }
    else showList();
  }

  qEl.addEventListener('input', renderList);
  sortEl.addEventListener('change', renderList);
  KOBE_I18N.onChange(function () { if (items.length) route(false); });
  window.addEventListener('hashchange', function () { route(true); });

  // whole card opens the detail view; the install button copies instead
  grid.addEventListener('click', function (e) {
    if (!e.target.closest || e.target.closest('.card-install') || e.target.closest('a')) return;
    var art = e.target.closest('.card');
    if (art) location.hash = art.getAttribute('data-ref');
  });

  // copy an install command (delegated on document — list and detail both render buttons)
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.card-install');
    if (!btn) return;
    var cmd = btn.getAttribute('data-cmd');
    try { if (navigator.clipboard) navigator.clipboard.writeText(cmd); } catch (err) {}
    var label = btn.querySelector('.cmd');
    label.textContent = KOBE_I18N.t('mk.copied');
    setTimeout(function () { label.textContent = cmd; }, 1500);
  });

  // Seed-only listings get their own banner, and the community disclaimer is
  // hidden — nothing community-published is on screen to disclaim.
  function seedNotice(key, isErr) {
    var host = document.getElementById('disclaimer');
    host.hidden = true;
    var n = document.createElement('div');
    n.className = isErr ? 'notice err' : 'notice';
    n.innerHTML = '<span class="mk" aria-hidden="true">!</span><span></span>';
    var msg = n.lastChild;
    function say() { msg.textContent = KOBE_I18N.t(key); }
    say();
    KOBE_I18N.onChange(say);
    host.insertAdjacentElement('beforebegin', n);
  }

  fetch('https://api.github.com/search/repositories?q=topic:kobe-plugin&sort=stars&order=desc&per_page=100')
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
    .then(function (d) {
      var repos = (d && d.items) || [];
      var parent = null;
      var community = repos.map(fromApi).filter(function (r) {
        if (r.ref !== FIRST_PARTY_REPO) return true;
        parent = r; // the seeds already cover it — keep its numbers, drop the card
        return false;
      });
      if (parent) {
        SEED.forEach(function (s) { s.stars = parent.stars; s.pushed = parent.pushed; s.created = parent.created; });
      }
      items = SEED.concat(community);
      if (!repos.length) seedNotice('mk.empty', false);
      // nothing community-published on screen → nothing for the disclaimer to disclaim
      else if (!community.length) document.getElementById('disclaimer').hidden = true;
      route(false);
    })
    .catch(function () { items = SEED; seedNotice('mk.offline', true); route(false); });
})();
