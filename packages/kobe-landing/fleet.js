// Fleet mock — Rove's own layout, made interactive: pick a task in the Tasks
// rail and the workspace tab strip, both panes, and the Files pane swap with it.
//
// Block structure mirrors the product (packages/kobe/src/tui-react): grouped
// task cards carrying their terminal tabs, a workspace tab strip, side-by-side
// panes, a status bar split between quota and key hints. The finish is a notch
// more polished than the real TUI on purpose — this is a marketing page.
//
// Everything inside the frame is TUI chrome and stays English, like the other
// terminal mocks here; only the prose around it is translated.
(function () {
  var rail = document.getElementById('fleetRail');
  var tagA = document.getElementById('fleetTagA');
  var tagB = document.getElementById('fleetTagB');
  var work = document.getElementById('fleetWork');
  var side = document.getElementById('fleetSide');
  if (!rail || !work || !side) return;

  var GROUPS = [
    {
      repo: 'rove',
      tasks: [
        { main: true, label: 'main' },
        {
          id: 'streaming-diff', label: 'streaming-diff', add: 142, del: 31,
          tabs: [{ glyph: '\u2839', cls: 'run', label: 'Stream the diff pane' }, { glyph: '\u00b7', label: 'group 2' }],
        },
        {
          id: 'oauth-refresh', label: 'oauth-refresh', add: 88, del: 54,
          tabs: [{ glyph: '\u25cf', cls: 'run', label: 'Refresh before 401' }, { glyph: '\u00b7', label: 'pytest' }],
        },
      ],
    },
    {
      repo: 'ledger-api',
      tasks: [{
        id: 'ledger-migration', label: 'ledger-migration', add: 34, del: 6,
        tabs: [{ glyph: '?', cls: 'wait', label: 'Backfill the ledger' }, { glyph: '\u00b7', label: 'psql' }],
      }],
    },
    {
      repo: 'storefront',
      tasks: [{
        id: 'flaky-e2e', label: 'flaky-e2e', add: 21, del: 34,
        tabs: [{ glyph: '\u25cb', label: 'Why checkout flakes' }, { glyph: '\u00b7', label: 'git' }],
      }],
    },
  ];

  var TASKS = {
    'streaming-diff': {
      tagA: 'claude', tab2: 'bun dev',
      work:
        '<span class="d">Claude Code v2.1.220</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="hi">stream the diff pane instead of buffering the whole patch</span>\n\n' +
        '<span class="hi">I\'ll split this into three moves:</span>\n' +
        '  • parse <span class="hi">git diff</span> as a line stream, not one blob\n' +
        '  • push hunks to the pane as they land\n' +
        '  • keep the scroll anchor pinned while rows append\n\n' +
        '<span class="ok">✓</span> edited <span class="hi">src/panes/diff/stream.ts</span>\n' +
        '<span class="d">⠹ Baking… (13m 44s · esc to interrupt)</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="fl-cursor"></span>',
      side:
        '<span class="ps">$</span> bun run dev\n\n' +
        '  <span class="ok">VITE v6.3.2</span>  ready in 341 ms\n\n' +
        '  ➜  Local:   <span class="hi">http://localhost:5173/</span>\n\n' +
        '<span class="d">12:04:11</span> hmr  diff/stream.ts\n' +
        '<span class="d">12:04:19</span> hmr  diff/rows.tsx\n' +
        '<span class="d">watching for file changes…</span>',
      scope: 'scope: vs main',
      files: [
        ['M', 'src/panes/diff/stream.ts', '+96', '−12'],
        ['M', 'src/panes/diff/rows.tsx', '+38', '−19'],
        ['A', 'test/diff/stream.test.ts', '+8', ''],
      ],
    },
    'oauth-refresh': {
      tagA: 'codex', tab2: 'pytest',
      work:
        '<span class="d">Codex CLI 0.9.1</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="hi">refresh tokens before they expire, not after a 401</span>\n\n' +
        '<span class="hi">Plan:</span>\n' +
        '  • read <span class="hi">expires_at</span> at load, schedule a refresh at T−60s\n' +
        '  • collapse concurrent refreshes behind one in-flight promise\n' +
        '  • keep the 401 retry only as a backstop\n\n' +
        '<span class="ok">✓</span> edited <span class="hi">auth/session.py</span>\n' +
        '<span class="wn">!</span> 2 tests still red — reading the fixtures\n' +
        '<span class="d">● Working… (6m 02s · esc to interrupt)</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="fl-cursor"></span>',
      side:
        '<span class="ps">$</span> pytest tests/auth -x -q\n' +
        '<span class="ok">........</span><span class="er">FF</span>\n\n' +
        '<span class="er">FAILED</span> test_refresh_ahead_of_expiry\n' +
        '  <span class="d">assert scheduled == expires − 60</span>\n' +
        '  <span class="d">E   assert 0 == 60</span>\n\n' +
        '<span class="d">8 passed, 2 failed in 1.31s</span>',
      scope: 'scope: working tree',
      files: [
        ['M', 'auth/session.py', '+61', '−40'],
        ['M', 'auth/client.py', '+27', '−14'],
        ['?', 'auth/.cache/', '', ''],
      ],
    },
    'ledger-migration': {
      tagA: 'copilot', tab2: 'psql',
      work:
        '<span class="d">Copilot CLI 1.4.0</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="hi">backfill the ledger table without locking writes</span>\n\n' +
        '<span class="hi">Drafted a two-phase migration:</span>\n' +
        '  • add the column nullable, backfill in 10k batches\n' +
        '  • flip <span class="hi">NOT NULL</span> once the backfill drains\n\n' +
        '<span class="wn">?</span> <span class="hi">This rewrites 2,418,905 production rows.</span>\n' +
        '  <span class="d">Run it now?</span>\n' +
        '  <span class="wn">❯ 1. Yes</span>\n' +
        '    <span class="d">2. No, keep the migration as a draft</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="fl-cursor"></span>',
      side:
        '<span class="ps">$</span> psql $DATABASE_URL\n' +
        '<span class="d">psql (16.3)</span>\n\n' +
        'rove=# <span class="hi">\\d ledger_entries</span>\n' +
        ' id         | bigint | not null\n' +
        ' amount_cts | bigint | not null\n' +
        ' <span class="wn">bucket_id</span>  | uuid   | <span class="wn">null</span>\n\n' +
        '<span class="d">-- 2,418,905 rows to backfill</span>',
      scope: 'scope: vs main',
      files: [
        ['A', 'migrations/0042_ledger_bucket.sql', '+34', ''],
        ['M', 'db/schema.sql', '+6', '−6'],
      ],
    },
    'flaky-e2e': {
      tagA: 'kimi', tab2: 'git',
      work:
        '<span class="d">Kimi CLI 0.6.2</span>\n\n' +
        '<span class="ps">&gt;</span> <span class="hi">find why the checkout e2e flakes ~1 run in 8</span>\n\n' +
        '<span class="hi">Root cause: a real timer, not a fake one.</span>\n' +
        '  • the suite waits 300ms for the toast\n' +
        '  • CI renders it in 280–420ms under load\n' +
        '  • replaced the sleep with a visibility wait\n\n' +
        '<span class="ok">✓</span> edited <span class="hi">e2e/checkout.spec.ts</span>\n' +
        '<span class="ok">✓</span> 200 consecutive runs, 0 failures\n' +
        '<span class="ok">✓</span> reported <span class="hi">succeeded</span> · 12m 08s\n\n' +
        '<span class="d">○ turn finished — nobody has looked yet</span>',
      side:
        '<span class="ps">$</span> git log --oneline -3\n' +
        '<span class="wn">a91c04e</span> fix(e2e): wait for the toast\n' +
        '<span class="wn">7d3e118</span> test(e2e): loop checkout 200×\n' +
        '<span class="wn">2f0ab55</span> chore: pin playwright image\n\n' +
        '<span class="ps">$</span> git diff --stat main\n' +
        ' 1 file  <span class="ok">+21</span> <span class="er">−34</span>\n\n' +
        '<span class="d">ready to land — awaiting your gate</span>',
      scope: 'scope: vs release/24.8',
      files: [
        ['M', 'e2e/checkout.spec.ts', '+21', '−34'],
        ['M', 'e2e/support/wait.ts', '+11', '−2'],
      ],
    },
  };

  var STATUS = { M: 'st-m', A: 'st-a', D: 'st-d', '?': 'st-q' };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  // Two-line card, like the product's task rows: the worktree line carries the
  // diffstat, and the line under it lists that task's terminal tabs with their
  // own state glyphs (the task row itself has none).
  function taskRow(task) {
    var btn = el('button', 'fl-row task');
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.setAttribute('data-task', task.id);
    btn.setAttribute('aria-selected', 'false');
    btn.tabIndex = -1;
    var head = el('span', 'fl-head');
    head.appendChild(el('span', 'lbl', task.label));
    head.appendChild(el('span', 'rhs',
      '<span class="add">+' + task.add + '</span> <span class="del">−' + task.del + '</span>'));
    btn.appendChild(head);
    btn.appendChild(el('span', 'fl-tabsline', task.tabs.map(function (tab) {
      return '<span class="fl-glyph ' + (tab.cls || '') + '">' + tab.glyph + '</span> ' + tab.label;
    // `|` not `·` — the middle dot is already the non-agent tab's state glyph
    }).join('<span class="sep">|</span>')));
    return btn;
  }

  function buildRail() {
    var tree = document.getElementById('fleetTree');
    GROUPS.forEach(function (group) {
      tree.appendChild(el('p', 'fl-group', '<span>' + group.repo + '</span>'));
      group.tasks.forEach(function (task) {
        if (task.main) {
          var row = el('div', 'fl-row main');
          var head = el('span', 'fl-head');
          head.appendChild(el('span', 'lbl', task.label));
          head.appendChild(el('span', 'rhs'));
          row.appendChild(head);
          tree.appendChild(row);
          return;
        }
        tree.appendChild(taskRow(task));
      });
    });
  }

  function render(id) {
    var t = TASKS[id];
    if (!t) return;
    tagA.textContent = t.tagA;
    tagB.textContent = t.tab2;
    work.querySelector('pre').innerHTML = t.work;
    side.querySelector('pre').innerHTML = t.side;
    document.getElementById('fleetScope').textContent = t.scope;
    var list = document.getElementById('fleetFileRows');
    list.innerHTML = '';
    t.files.forEach(function (f) {
      var row = el('div', 'fl-file');
      row.appendChild(el('span', 'p',
        '<span class="' + (STATUS[f[0]] || '') + '">' + f[0] + '</span> ' + f[1]));
      row.appendChild(el('span', 'st',
        (f[2] ? '<span class="add">' + f[2] + '</span>' : '') +
        (f[3] ? ' <span class="del">' + f[3] + '</span>' : '')));
      list.appendChild(row);
    });
  }

  function select(btn) {
    rail.querySelectorAll('.fl-row.task').forEach(function (b) {
      var on = b === btn;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    render(btn.getAttribute('data-task'));
    showView('split');
  }

  buildRail();

  rail.addEventListener('click', function (e) {
    var btn = e.target.closest('.fl-row.task');
    if (btn) select(btn);
  });

  // roving cursor, matching the pane's own j/k vocabulary
  rail.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(rail.querySelectorAll('.fl-row.task'));
    var i = items.indexOf(document.activeElement);
    if (i < 0) return;
    var step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    var next = step ? i + step : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (next < 0 || next >= items.length) return;
    e.preventDefault();
    items[next].focus();
    select(items[next]);
  });

  // The nav rail swaps the whole workspace column for a full-window page,
  // the way Kanban / Routines / Inbox replace the terminal in the product.
  function showView(name) {
    var split = name === 'split' || name === 'inbox';
    document.querySelector('.fl-work').hidden = !split;
    document.getElementById('fleetFiles').hidden = !split;
    document.getElementById('fleetKanban').hidden = name !== 'kanban';
    document.getElementById('fleetRoutines').hidden = name !== 'routines';
    // the Inbox is a dialog: it covers the frame instead of replacing a column
    document.getElementById('fleetInbox').hidden = name !== 'inbox';
    document.querySelectorAll('.fl-nav').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === name));
    });
    // a page owns the whole column, so the rail's task cursor goes quiet
    rail.classList.toggle('page-open', name === 'kanban' || name === 'routines');
  }

  document.querySelectorAll('.fl-nav').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var view = btn.getAttribute('data-view');
      showView(btn.getAttribute('aria-pressed') === 'true' ? 'split' : view);
    });
  });

  select(rail.querySelector('.fl-row.task'));
  showView('split');
})();
