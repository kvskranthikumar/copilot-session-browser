/* eslint-disable */
// Copilot Session Browser — webview script
// Loaded as an external file so VS Code's CSP (script-src ${webview.cspSource}) allows it.
// Data is passed via the hidden #__ws_data__ div embedded in the HTML.

(function () {
  'use strict';

  // ── FIRST: catch any JS error and surface it in the debug banner ───────────
  window.onerror = function (msg, _src, line, col) {
    const d = document.getElementById('debug-banner');
    if (d) d.textContent = 'JS ERROR: ' + msg + ' (line ' + line + ':' + col + ')';
    return false;
  };

  const vscode = acquireVsCodeApi();

  // ── State ──────────────────────────────────────────────────────────────────
  let allSessions = [];
  let discoveredWorkspaces = (function () {
    try {
      const el = document.getElementById('__ws_data__');
      return JSON.parse(el ? el.textContent || '[]' : '[]');
    } catch (e) {
      return [];
    }
  })();
  let currentView   = 'workspaces'; // 'workspaces' | 'sessions'
  let selectedWsKey = null;
  let activePeriod  = 'all';
  let activeSearch  = '';
  let wsSearch            = '';
  let wsShowWithSessions  = true; // true = With sessions only (default)
  let currentSort   = 'updatedAt|desc';
  let ctxSessionId  = null;

  // ── Init ───────────────────────────────────────────────────────────────────
  try {
    renderWorkspaces();
    const s = discoveredWorkspaces.length;
    setStatus(s + ' workspace' + (s !== 1 ? 's' : ''));
  } catch (e) {
    console.error('[CSB] renderWorkspaces error:', e);
  }

  vscode.postMessage({ type: 'ready' });

  // ── Message handler ────────────────────────────────────────────────────────
  window.addEventListener('message', function (evt) {
    const msg = evt.data;
    if (msg.type === 'sessions') {
      allSessions = msg.items || [];
      if (msg.discoveredWorkspaces && msg.discoveredWorkspaces.length > 0) {
        discoveredWorkspaces = msg.discoveredWorkspaces;
      }
      if (currentView === 'workspaces') {
        renderWorkspaces();
      } else {
        renderSessions();
      }
      const totalSessions = allSessions.length;
      const totalWs = discoveredWorkspaces.length;
      setStatus(
        totalWs  + ' workspace' + (totalWs  !== 1 ? 's' : '') +
        (totalSessions > 0 ? ' · ' + totalSessions + ' session' + (totalSessions !== 1 ? 's' : '') : '')
      );
    } else if (msg.type === 'status') {
      setStatus(msg.message);
    }
  });

  // ── Status bar ─────────────────────────────────────────────────────────────
  function setStatus(msg) {
    const bar = document.getElementById('status-bar');
    if (bar) bar.textContent = msg;
  }

  // ── Path helpers ───────────────────────────────────────────────────────────
  function normalizePath(p) {
    if (!p) { return ''; }
    // Strip file URI scheme the same way discoveryService does, so that
    // "file:///C:/path" and "/C:/path" and "C:/path" all normalise identically.
    let s = p.replace(/^file:\/\/\//, '/').replace(/^file:\/\//, '');
    s = s.replace(/\\/g, '/');
    if (/^\/[a-zA-Z]:\//.test(s)) { s = s.slice(1); }
    return s.toLowerCase();
  }

  function wsKey(s)    { return s.workspaceContext || '__unknown__'; }
  function wsDisplayName(key) {
    if (!key || key === '__unknown__') { return 'Unknown workspace'; }
    const parts = key.replace(/\\\\/g, '/').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.pop() || key;
  }

  function groupByWorkspace(sessions) {
    const map = new Map();
    for (const s of sessions) {
      const key = wsKey(s);
      if (!map.has(key)) {
        map.set(key, { key, displayName: wsDisplayName(key), fullPath: key, sessions: [] });
      }
      map.get(key).sessions.push(s);
    }
    return Array.from(map.values()).sort(function (a, b) { return b.sessions.length - a.sessions.length; });
  }

  // ── Workspace View ─────────────────────────────────────────────────────────
  function showWorkspaceView() {
    currentView   = 'workspaces';
    selectedWsKey = null;
    document.getElementById('workspace-view').style.display = 'flex';
    document.getElementById('session-view').style.display   = 'none';
    renderWorkspaces();
  }

  function renderWorkspaces() {
    const list  = document.getElementById('workspace-list');
    const query = wsSearch.toLowerCase();

    const sessionCountByContext = new Map();
    for (const s of allSessions) {
      const k = normalizePath(s.workspaceContext || '');
      sessionCountByContext.set(k, (sessionCountByContext.get(k) || 0) + 1);
    }

    let workspaces;
    if (discoveredWorkspaces.length > 0) {
      workspaces = discoveredWorkspaces.map(function (w) {
        // Match by normalised folderPath first; fall back to raw hash so that
        // sessions whose workspaceContext was set to the hash string are counted.
        const countByPath = sessionCountByContext.get(normalizePath(w.folderPath)) || 0;
        const countByHash = w.hash ? (sessionCountByContext.get(w.hash.toLowerCase()) || 0) : 0;
        return {
          key:         w.folderPath || w.hash,
          displayName: w.label,
          fullPath:    w.folderPath || w.hash,
          hash:        w.hash,
          count:       countByPath || countByHash,
        };
      });
      if (query) {
        workspaces = workspaces.filter(function (w) {
          return w.displayName.toLowerCase().includes(query) || w.fullPath.toLowerCase().includes(query);
        });
      }
      workspaces.sort(function (a, b) {
        return b.count - a.count || a.displayName.localeCompare(b.displayName);
      });
    } else if (allSessions.length > 0) {
      const grouped = groupByWorkspace(allSessions);
      workspaces = grouped
        .filter(function (w) {
          return !query || w.displayName.toLowerCase().includes(query) || w.fullPath.toLowerCase().includes(query);
        })
        .map(function (w) {
          return { key: w.key, displayName: w.displayName, fullPath: w.fullPath, hash: '', count: w.sessions.length };
        });
    } else {
      workspaces = [];
    }

    // Apply with-sessions filter
    if (wsShowWithSessions) {
      workspaces = workspaces.filter(function (w) { return w.count > 0; });
    }

    if (workspaces.length === 0) {
      const hasNoData = discoveredWorkspaces.length === 0 && allSessions.length === 0;
      list.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px 16px;text-align:center;opacity:0.7">' +
        '<div style="font-size:32px">💬</div>' +
        (hasNoData
          ? '<p style="font-size:12px;line-height:1.5">No workspaces found.<br>Sessions are loaded from local VS Code storage.</p>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">' +
            '<button class="btn" id="ws-btn-import">Import JSON/MD</button>' +
            '<button class="btn" id="ws-btn-diagnostics">Diagnostics</button>' +
            '<button class="btn" id="ws-btn-refresh">Refresh</button>' +
            '</div>'
          : '<p style="font-size:12px;line-height:1.5">No workspaces match the filter.</p>'
        ) + '</div>';
      const btnImport = document.getElementById('ws-btn-import');
      const btnDiag   = document.getElementById('ws-btn-diagnostics');
      const btnRef    = document.getElementById('ws-btn-refresh');
      if (btnImport) btnImport.addEventListener('click', function () { vscode.postMessage({ type: 'import' }); });
      if (btnDiag)   btnDiag.addEventListener('click',   function () { vscode.postMessage({ type: 'diagnostics' }); });
      if (btnRef)    btnRef.addEventListener('click',    function () { vscode.postMessage({ type: 'refresh' }); });
      setStatus(hasNoData ? 'No workspaces found' : 'No workspaces match filter');
      return;
    }

    const totalSessions = allSessions.length;
    const totalWs = discoveredWorkspaces.length || workspaces.length;
    setStatus(
      totalWs + ' workspace' + (totalWs !== 1 ? 's' : '') +
      (totalSessions > 0 ? ' · ' + totalSessions + ' session' + (totalSessions !== 1 ? 's' : '') : '')
    );

    list.innerHTML =
      '<button class="all-sessions-btn" data-key="__all__">📋 All sessions (' + totalSessions + ')</button>' +
      workspaces.map(function (w) {
        const countLabel = w.count > 0
          ? w.count + ' session' + (w.count !== 1 ? 's' : '')
          : 'No sessions';
        return (
          '<button class="ws-item" data-key="' + escAttr(w.key) + '" title="' + escAttr(w.fullPath) + '">' +
          '<span class="ws-icon">📁</span>' +
          '<div class="ws-info">' +
          '<div class="ws-name">' + escHtml(w.displayName) + '</div>' +
          '<div class="ws-meta">' + countLabel + '</div>' +
          '</div>' +
          '<span class="ws-arrow">›</span>' +
          '</button>'
        );
      }).join('');
  }

  document.getElementById('ws-search').addEventListener('input', function (e) {
    wsSearch = e.target.value.trim();
    renderWorkspaces();
  });

  document.getElementById('ws-filter-bar').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-wsfilter]');
    if (!btn) { return; }
    wsShowWithSessions = btn.dataset.wsfilter === 'with-sessions';
    document.querySelectorAll('[data-wsfilter]').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    renderWorkspaces();
  });

  // ── Session View ───────────────────────────────────────────────────────────
  function selectWorkspace(key) {
    selectedWsKey = key;
    currentView   = 'sessions';
    document.getElementById('workspace-view').style.display = 'none';
    document.getElementById('session-view').style.display   = 'flex';

    const label = key === '__all__' ? 'All Sessions' : wsDisplayName(key);
    const crumb = document.getElementById('ws-breadcrumb-name');
    crumb.textContent = label;
    crumb.title       = (key === '__all__' || key === '__unknown__') ? '' : key;

    activeSearch = '';
    activePeriod = 'all';
    document.getElementById('search').value = '';
    document.querySelectorAll('.filter-btn').forEach(function (b, i) {
      b.classList.toggle('active', i === 0);
    });

    // ── Diagnostics ──
    var normSelectedKey = normalizePath(key);
    var wsEntry = discoveredWorkspaces.find(function (w) {
      return normalizePath(w.folderPath || '') === normSelectedKey
          || w.hash === key
          || normalizePath(w.hash) === normSelectedKey;
    });
    var wsHash = wsEntry ? wsEntry.hash.toLowerCase() : null;
    var matched = allSessions.filter(function (s) {
      var sk = wsKey(s);
      return key === '__all__'
          || normalizePath(sk) === normSelectedKey
          || sk === key
          || (wsHash && sk.toLowerCase() === wsHash);
    });
    renderSessions();
  }
  window.selectWorkspace = selectWorkspace;

  document.getElementById('btn-back').addEventListener('click', showWorkspaceView);

  // ── Event delegation — replaces CSP-blocked inline onclick handlers ────────
  // Workspace list: any element with data-key triggers selectWorkspace
  document.getElementById('workspace-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-key]');
    if (btn) { selectWorkspace(btn.dataset.key); }
  });

  // Session list: delegated click + contextmenu
  var sesList = document.getElementById('session-list');
  sesList.addEventListener('click', function (e) {
    // ctx-trigger carries its own data-id
    var ctxBtn = e.target.closest('.ctx-trigger');
    if (ctxBtn && ctxBtn.dataset.id) {
      e.stopPropagation();
      showCtx(ctxBtn.dataset.id, e.clientX || e.pageX, e.clientY || e.pageY);
      return;
    }
    var item = e.target.closest('.session-item[data-id]');
    if (item) { openSession(item.dataset.id); }
  });
  sesList.addEventListener('contextmenu', function (e) {
    if (e.target.closest('.ctx-trigger')) { return; }
    var item = e.target.closest('.session-item[data-id]');
    if (item) { e.preventDefault(); showCtx(item.dataset.id, e.clientX || e.pageX, e.clientY || e.pageY); }
  });

  // ── Search / Sort / Period ─────────────────────────────────────────────────
  const searchInput = document.getElementById('search');
  searchInput.addEventListener('input', function () {
    activeSearch = searchInput.value.toLowerCase().trim();
    renderSessions();
  });
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { focusItem(0); e.preventDefault(); }
    if (e.key === 'Escape')    { searchInput.value = ''; activeSearch = ''; renderSessions(); }
  });

  document.getElementById('sort').addEventListener('change', function (e) {
    currentSort = e.target.value;
    renderSessions();
  });

  document.querySelectorAll('.filter-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      activePeriod = btn.dataset.period;
      renderSessions();
    });
  });

  // ── Context menu ───────────────────────────────────────────────────────────
  const ctxMenu = document.getElementById('ctx-menu');
  document.getElementById('ctx-view').addEventListener('click',       function () { openSession(ctxSessionId); hideCtx(); });
  document.getElementById('ctx-sum-short').addEventListener('click',  function () { vscode.postMessage({ type: 'summarizeShort',   sessionId: ctxSessionId }); hideCtx(); });
  document.getElementById('ctx-sum-detail').addEventListener('click', function () { vscode.postMessage({ type: 'summarizeDetailed', sessionId: ctxSessionId }); hideCtx(); });
  document.getElementById('ctx-export').addEventListener('click',     function () { vscode.postMessage({ type: 'exportSession',    sessionId: ctxSessionId }); hideCtx(); });
  document.addEventListener('click',   function (e) { if (!ctxMenu.contains(e.target)) { hideCtx(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideCtx(); } });

  function showCtx(sessionId, x, y) {
    ctxSessionId = sessionId;
    ctxMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
    ctxMenu.style.top  = Math.min(y, window.innerHeight - 160) + 'px';
    ctxMenu.classList.add('open');
    document.getElementById('ctx-view').focus();
  }
  function hideCtx() { ctxMenu.classList.remove('open'); ctxSessionId = null; }

  // ── Session rendering ──────────────────────────────────────────────────────
  function getVisibleSessions() {
    let sessions = allSessions;
    if (selectedWsKey && selectedWsKey !== '__all__') {
      const normKey = normalizePath(selectedWsKey);
      // Also find the workspace entry so we can match sessions stored with only
      // the workspace hash as their workspaceContext (V5 / modern format).
      const wsEntry = discoveredWorkspaces.find(function (w) {
        return normalizePath(w.folderPath || '') === normKey
            || w.hash === selectedWsKey
            || normalizePath(w.hash) === normKey;
      });
      const wsHash = wsEntry ? wsEntry.hash.toLowerCase() : null;
      sessions = sessions.filter(function (s) {
        const sk = wsKey(s);
        const m = normalizePath(sk) === normKey
               || sk === selectedWsKey
               || (wsHash && sk.toLowerCase() === wsHash);
        if (!m) {
          console.log('[CSB] SKIP session ws="' + sk + '" normsk="' + normalizePath(sk) + '" normKey="' + normKey + '" wsHash="' + wsHash + '"');
        }
        return m;
      });
      console.log('[CSB] getVisibleSessions: selectedWsKey="' + selectedWsKey + '" normKey="' + normKey + '" wsHash="' + wsHash + '" matched=' + sessions.length + '/' + allSessions.length);
    }
    const now = Date.now(), DAY = 86400000;
    sessions = sessions.filter(function (s) {
      if (activePeriod === 'today')    { return now - new Date(s.updatedAt).getTime() <= DAY; }
      if (activePeriod === 'week')     { return now - new Date(s.updatedAt).getTime() <= 7 * DAY; }
      if (activePeriod === 'month')    { return now - new Date(s.updatedAt).getTime() <= 30 * DAY; }
      if (activePeriod === 'imported') { return s.tags.includes('imported'); }
      return true;
    });
    if (activeSearch) {
      sessions = sessions.filter(function (s) {
        const hay = (s.title + ' ' + (s.workspaceContext || '') + ' ' + s.tags.join(' ')).toLowerCase();
        return hay.includes(activeSearch);
      });
    }
    return sessions;
  }

  function sortSessions(sessions) {
    const parts = currentSort.split('|');
    const field = parts[0], order = parts[1];
    return sessions.slice().sort(function (a, b) {
      let va, vb;
      if (field === 'title')             { va = a.title.toLowerCase();          vb = b.title.toLowerCase(); }
      else if (field === 'messageCount') { va = a.messageCount;                  vb = b.messageCount; }
      else                               { va = new Date(a[field]).getTime();    vb = new Date(b[field]).getTime(); }
      if (va < vb) { return order === 'asc' ? -1 :  1; }
      if (va > vb) { return order === 'asc' ?  1 : -1; }
      return 0;
    });
  }

  function renderSessions() {
    const visible = sortSessions(getVisibleSessions());
    const list    = document.getElementById('session-list');
    const empty   = document.getElementById('empty-state');
    const sbar    = document.getElementById('session-status-bar');

    if (visible.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'flex';
      document.getElementById('empty-message').textContent =
        allSessions.length === 0 ? 'No sessions found.' : 'No sessions match the current filter.';
      if (sbar) { sbar.textContent = '0 sessions'; }
      return;
    }
    empty.style.display = 'none';
    if (sbar) {
      sbar.textContent = visible.length + ' session' + (visible.length !== 1 ? 's' : '') + (activeSearch ? ' (filtered)' : '');
    }

    list.innerHTML = visible.map(function (s, idx) {
      const tags = s.tags.length
        ? '<div class="session-tags">' + s.tags.map(function (t) { return '<span class="tag">' + escHtml(t) + '</span>'; }).join('') + '</div>'
        : '';
      return (
        '<div class="session-item" role="listitem" ' +
        'data-id="' + escAttr(s.id) + '" ' +
        'tabindex="' + (idx === 0 ? '0' : '-1') + '" ' +
        'aria-label="Session: ' + escAttr(s.title) + '">' +
        '<div class="session-title">' + escHtml(s.title) + '</div>' +
        '<div class="session-meta">' +
        '<span>' + formatRelativeDate(s.updatedAt) + '</span>' +
        '<span>' + s.messageCount + ' msg' + (s.messageCount !== 1 ? 's' : '') + '</span>' +
        '</div>' +
        tags +
        '<button class="ctx-trigger" data-id="' + escAttr(s.id) + '" aria-label="More options">⋯</button>' +
        '</div>'
      );
    }).join('');

    list.querySelectorAll('.session-item').forEach(function (item, idx) {
      item.setAttribute('tabindex', idx === 0 ? '0' : '-1');
      item.addEventListener('keydown', function (e) {
        const items = Array.from(list.querySelectorAll('.session-item'));
        if (e.key === 'ArrowDown')                 { focusItem(idx + 1); e.preventDefault(); }
        else if (e.key === 'ArrowUp')              { if (idx === 0) { searchInput.focus(); } else { focusItem(idx - 1); } e.preventDefault(); }
        else if (e.key === 'Enter')                { openSession(item.dataset.id); }
        else if (e.key === 'F10' && e.shiftKey)    { handleCtx(e, item.dataset.id); e.preventDefault(); }
      });
    });
  }

  function focusItem(idx) {
    const items = Array.from((document.getElementById('session-list') || { querySelectorAll: function () { return []; } }).querySelectorAll('.session-item'));
    const target = items[Math.max(0, Math.min(idx, items.length - 1))];
    if (target) {
      items.forEach(function (it, i) { it.setAttribute('tabindex', i === idx ? '0' : '-1'); });
      target.focus();
    }
  }

  function openSession(sessionId) { vscode.postMessage({ type: 'openSession', sessionId: sessionId }); }
  // Exposed to inline onclick in dynamically rendered session items
  window.openSession   = openSession;
  function handleCtx(e, sessionId) { e.preventDefault(); e.stopPropagation(); showCtx(sessionId, e.clientX || e.pageX, e.clientY || e.pageY); }
  function handleCtxEl(e, id)      { handleCtx(e, id); }
  window.handleCtxEl   = handleCtxEl;

  function formatRelativeDate(iso) {
    var d = new Date(iso), diff = Date.now() - d.getTime(), DAY = 86400000;
    if (diff < 60000)    { return 'just now'; }
    if (diff < 3600000)  { return Math.floor(diff / 60000) + 'm ago'; }
    if (diff < DAY)      { return Math.floor(diff / 3600000) + 'h ago'; }
    if (diff < 7 * DAY)  { return Math.floor(diff / DAY) + 'd ago'; }
    return d.toLocaleDateString();
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) {
    return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

})();
