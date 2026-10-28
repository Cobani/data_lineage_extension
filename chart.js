'use strict';

/**
 * Data Lineage — Tableau Viz Extension.
 *
 * Marks card tiles (declared in data-lineage.trex):
 *   levels   Levels: 1–6 dimensions, source → target (e.g. Table, Data Source,
 *            Workbook, View). Every row of the summary data is one path; every
 *            dimension is a column of nodes, linked to the next column.
 *   details  Details: optional dimensions shown as node subtitles. Each one
 *            goes under the level it describes (found automatically, or set in
 *            Format → Levels). Fields on Tableau's Tooltip / Detail tiles are
 *            shown in the tooltip.
 *
 * Click a node: its lineage (every path through it) is highlighted and the
 * value is selected in Tableau, for dashboard actions. Header (icon, title,
 * explanation) is KPI Card's; everything else is set in the Format dialog
 * (configure.html), which also opens from the right-click menu.
 */
(function () {
  var el = {};
  var worksheet = null;
  var cfg = null;
  var raw = null; // extracted data, see extract()
  var graph = null; // nodes, edges and layout of the last paint, see buildGraph()
  var renderToken = 0;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SEP = '\u0001';

  /** In-memory state (not saved). */
  var state = {
    sel: null, // id of the clicked node
    hover: null, // id of the hovered node
    query: '' // search text
  };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'tools', 'legend', 'legendrow', 'searchbox', 'search', 'plot', 'headers',
      'canvas', 'svg', 'nodes', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.nodes.addEventListener('mousemove', onHover);
    el.plot.addEventListener('mouseleave', function () { setHover(null); hideTooltip(); });
    el.plot.addEventListener('scroll', function () { hideTooltip(); hideMenu(); });
    el.plot.addEventListener('click', onClick);
    el.plot.addEventListener('dblclick', onDblClick);
    el.plot.addEventListener('contextmenu', onContextMenu);
    el.card.addEventListener('contextmenu', function (e) { if (!el.plot.contains(e.target) && e.target !== el.search) onContextMenu(e); });
    document.addEventListener('mousedown', function (e) { if (!el.menu.contains(e.target)) hideMenu(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        hideMenu();
        if (document.activeElement === el.search && el.search.value) { el.search.value = ''; onSearch(); return; }
        if (state.sel) select(null);
      }
    });
    window.addEventListener('blur', hideMenu);

    var searchTimer = null;
    el.search.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(onSearch, 140); });
    el.search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(searchTimer); onSearch(true); } });

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start');
    return tableau.extensions.initializeAsync({ configure: function () { return openDialog(null); } }).then(function () {
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Dl.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, function () { loadParams(); refresh(); });
      loadParams();
      tableau.extensions.settings.addEventListener(tableau.TableauEventType.SettingsChanged, function () {
        // while the dialog's live preview drives the chart, saves (which lag behind it) are ignored
        if (liveActive) return;
        cfg = Dl.read(); paint();
      });
      window.addEventListener('storage', onLiveSettings);

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      console.error('Data Lineage failed to initialize:', err);
      showEmpty('Could not initialize the extension. See the console for details.');
    });
  }

  var queued = false;
  var lastSize = '';
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var sz = el.card.clientWidth + 'x' + el.card.clientHeight;
      if (sz === lastSize && graph) return;
      paint();
    });
  }

  // ---------------------------------------------------------------------------
  // Parameters: for <Parameter> in the title / explanation
  // ---------------------------------------------------------------------------
  var params = {};
  var paramWatch = {};
  function loadParams () {
    try {
      if (!worksheet || !worksheet.getParametersAsync) return Promise.resolve();
      return worksheet.getParametersAsync().then(function (list) {
        var next = {};
        (list || []).forEach(function (p) {
          var cv = p.currentValue || {};
          next[String(p.name).toLowerCase()] = { name: p.name, value: cv.formattedValue != null ? String(cv.formattedValue) : String(cv.value) };
          var id = p.id || p.name;
          if (!paramWatch[id] && p.addEventListener && tableau.TableauEventType.ParameterChanged) {
            paramWatch[id] = true;
            p.addEventListener(tableau.TableauEventType.ParameterChanged, function () { loadParams().then(function () { if (raw) paintHeader(); }); });
          }
        });
        var changed = JSON.stringify(next) !== JSON.stringify(params);
        params = next;
        if (changed && raw && cfg) paintHeader();
      }).catch(function (e) { console.info('Data Lineage: parameters not available', e && e.message); });
    } catch (e) { return Promise.resolve(); }
  }

  function paramValue (name) {
    var k = String(name || '').trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase();
    return params[k] ? params[k].value : null;
  }

  /** "<Region Param>" → its value; {paths} {nodes} {flow} → numbers of this chart. */
  function fillText (text) {
    var g = graph;
    return String(text || '')
      .replace(/<([^<>]+)>/g, function (all, nm) { var v = paramValue(nm); return v != null ? v : all; })
      .replace(/\{paths\}/gi, function () { return g ? g.pathCount.toLocaleString('en-US') : ''; })
      .replace(/\{nodes\}/gi, function () { return g ? g.nodes.length.toLocaleString('en-US') : ''; })
      .replace(/\{flow\}/gi, function () { return raw ? raw.levels.map(function (f, i) { return legendName(i).toLowerCase(); }).join(' → ') : ''; });
  }

  // ---------------------------------------------------------------------------
  // Live preview: the Format dialog also writes its settings to localStorage
  // (same origin), so the chart redraws at once instead of waiting for Tableau
  // to save them; the chart sends back what the dialog lists. Tableau's save
  // still follows.
  // ---------------------------------------------------------------------------
  var liveId = 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  var liveActive = false;
  var infoTimer = null;
  function onLiveSettings (e) {
    if (e.key !== 'datalineage:live:' + liveId || !e.newValue) return;
    try {
      var o = JSON.parse(e.newValue);
      liveActive = true;
      cfg = Dl.readFrom(o.cfg);
    } catch (err) { return; }
    paint();
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      try { if (raw) window.localStorage.setItem('datalineage:info:' + liveId, JSON.stringify(dialogInfo(null))); } catch (err) { /* ignore */ }
    }, 120);
  }

  function openDialog (focus) {
    hideMenu();
    hideTooltip();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify(dialogInfo(focus));
    var options = { width: 620, height: 780 };
    // On top (Modal) keeps the Format window in front of Tableau until Done; Floating (Modeless) lets you click the workbook but can fall behind it.
    var DS = tableau.DialogStyle || {};
    var style = cfg && cfg.interaction.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    var done = function () {
      if (!liveActive) return;
      liveActive = false;
      // the dialog may have closed before its last save: the chart has its latest settings, so it saves them
      try {
        if (tableau.extensions.settings.get(Dl.STORAGE_KEY) !== JSON.stringify(cfg)) Dl.write(cfg).catch(function () { /* viewer: can't save */ });
      } catch (e) { /* ignore */ }
      paint();
    };
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).then(done, function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Data Lineage dialog:', err && err.message);
      done();
    });
  }

  /** What the dialog needs to list: level fields, detail fields (and where they go), parameters. */
  function dialogInfo (focus) {
    var info = { focus: focus || null, liveId: liveId, levels: [], extras: [], params: [], pathCount: 0 };
    info.params = Object.keys(params).map(function (k) { return { name: params[k].name, value: params[k].value }; });
    if (!raw) return info;
    info.levels = raw.levels.map(function (f, i) {
      var vals = graph ? graph.cols[i].length : 0;
      return { key: f.key, name: f.name, count: vals };
    });
    info.extras = raw.extras.map(function (x, j) { return { key: x.key, name: x.name, tile: x.tile, autoLevel: autoLevels()[j] }; });
    info.pathCount = graph ? graph.pathCount : 0;
    return info;
  }

  // ---------------------------------------------------------------------------
  // Last-render cache (same approach as the other extensions)
  // ---------------------------------------------------------------------------
  var CACHE_PREFIX = 'datalineage:lastRender:v1:';
  var CACHE_MAX_AGE = 30 * 24 * 3600 * 1000;
  var CACHE_MAX_CHARS = 400000;
  var cacheTried = false;

  function cacheKey () {
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    return CACHE_PREFIX + host + '|' + (worksheet && worksheet.name);
  }

  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  function readCacheEntry () {
    try {
      var s = window.localStorage.getItem(cacheKey());
      if (!s) return null;
      var c = JSON.parse(s);
      if (!c || !c.data || !(Date.now() - c.t < CACHE_MAX_AGE)) return null;
      return c;
    } catch (e) { return null; }
  }

  function writeCache (fields, data) {
    try {
      var s = JSON.stringify({ sig: fieldsSig(fields), t: Date.now(), data: data });
      if (s.length > CACHE_MAX_CHARS) return;
      try {
        window.localStorage.setItem(cacheKey(), s);
      } catch (full) {
        for (var i = window.localStorage.length - 1; i >= 0; i--) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) window.localStorage.removeItem(k);
        }
        window.localStorage.setItem(cacheKey(), s);
      }
    } catch (e) { /* ignore */ }
  }

  function clearCache () {
    try { window.localStorage.removeItem(cacheKey()); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  var TILES = ['levels', 'details', 'tooltip', 'detail'];

  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      var tFields = 0;
      var tData = 0;
      var fieldsP = getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      if (!cacheTried) {
        cacheTried = true;
        var entry = readCacheEntry();
        if (entry && !raw) {
          raw = entry.data;
          try { paint(); T.mark('cached result drawn'); } catch (e) { raw = null; entry = null; }
        }
        if (entry) {
          fieldsP.then(function (f) {
            if (token !== renderToken || raw !== entry.data || entry.sig === fieldsSig(f)) return;
            raw = null;
            showEmpty('');
            T.mark('cached result removed (fields changed)');
          }).catch(function () { /* handled below */ });
        }
      }

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      if (!fields.levels.length) {
        raw = null;
        graph = null;
        clearCache();
        if (first) { T.mark('no field on Levels'); T.done('Data Lineage load timings'); }
        showEmpty('Drag dimensions onto <b>Levels</b>, one by one from source to target<br>(e.g. <b>Table</b>, <b>Data Source</b>, <b>Workbook</b>, <b>View</b>). ' +
          'Each one becomes a column and every row is a path.<br>Optional: <b>Details</b> adds subtitles to the nodes (schema, connection type…).');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      var prevSig = raw && raw.sig;
      raw = extract(table, fields);
      raw.sig = fieldsSig(fields);
      if (prevSig && prevSig !== raw.sig) state.sel = null;
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Data Lineage load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
      var toSave = raw;
      (window.requestIdleCallback || function (f) { return setTimeout(f, 800); })(function () { if (raw === toSave) writeCache(fields, toSave); }, { timeout: 4000 });
    } catch (err) {
      console.error('Data Lineage render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Data Lineage load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. See the console for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = {};
    TILES.forEach(function (t) { fields[t] = []; });
    marks.encodings.forEach(function (e) {
      if (!e.field) return;
      var type = String(e.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : e.id;
      if (!fields[id]) return; // colour, size … are not used
      fields[id].push(e.field);
    });
    return fields;
  }

  async function readSummaryData () {
    var reader = await worksheet.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
    try {
      return await reader.getAllPagesAsync();
    } finally {
      await reader.releaseAsync();
    }
  }

  function norm (s) {
    return String(s || '').replace(/^[A-Z_]+\((.*)\)$/i, '$1').trim().toLowerCase();
  }

  function nameParts (s) {
    var str = String(s || '');
    var i = str.indexOf('//');
    if (i < 0) return [norm(str)];
    return [norm(str.slice(i + 2)), norm(str.slice(0, i))].filter(Boolean);
  }

  function isMN (c) { return /^measure (names|values)$/i.test(c.fieldName); }

  /** Field id → exact name → normalised name → name parts (renamed pills). */
  function findColumn (table, field, taken) {
    if (!field) return null;
    var cols = table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    var fid = field.id || field.fieldId;
    var fn = nameParts(field.name);
    return cols.find(function (c) { return fid && c.fieldId && c.fieldId === fid; }) ||
      cols.find(function (c) { return c.fieldName === field.name; }) ||
      cols.find(function (c) { return norm(c.fieldName) === norm(field.name); }) ||
      cols.find(function (c) {
        var cn = nameParts(c.fieldName);
        return cn.some(function (x) { return fn.indexOf(x) >= 0; });
      }) ||
      null;
  }

  function cleanName (name) {
    return String(name || '').replace(/^(ATTR|MIN|MAX)\((.*)\)$/i, '$2');
  }

  function cellText (cell) {
    if (!cell) return null;
    var v = cell.value;
    if (v === null || v === undefined || v === '%null%') return null;
    var f = cell.formattedValue;
    if (f == null || f === '%null%') f = v;
    f = String(f);
    return f === '' ? null : f;
  }

  /**
   * Summary data → { levels: [{ key, name }], extras: [{ key, name, tile }],
   *                  rows: [[level values…], [extra values…]] } (null = empty)
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var reqs = [];
    var levels = fields.levels.map(function (f) {
      var r = { field: f, key: f.name, name: cleanName(f.name), col: null };
      reqs.push(r);
      return r;
    });
    var extras = [];
    var seen = {};
    levels.forEach(function (l) { seen[l.key] = 1; });
    [['details', 'details'], ['detail', 'tooltip'], ['tooltip', 'tooltip']].forEach(function (t) {
      fields[t[0]].forEach(function (f) {
        if (seen[f.name]) return;
        seen[f.name] = 1;
        var r = { field: f, key: f.name, name: cleanName(f.name), tile: t[1], col: null };
        reqs.push(r);
        extras.push(r);
      });
    });
    reqs.forEach(function (r) { r.col = findColumn(table, r.field, taken); if (r.col) taken.push(r.col); });
    // renamed pills: unmatched fields take the free columns in order
    var guessed = [];
    reqs.forEach(function (r) {
      if (r.col) return;
      var free = table.columns.find(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
      if (free) { r.col = free; taken.push(free); guessed.push(r.key + ' → ' + free.fieldName); }
    });
    if (guessed.length) console.info('Data Lineage: matched renamed fields by position:', guessed);

    var out = [];
    rows.forEach(function (row) {
      var p = levels.map(function (l) { return l.col ? cellText(row[l.col.index]) : null; });
      if (p.every(function (v) { return v == null; })) return;
      var x = extras.map(function (e) { return e.col ? cellText(row[e.col.index]) : null; });
      out.push([p, x]);
    });
    return {
      levels: levels.map(function (l) { return { key: l.key, name: l.name }; }),
      extras: extras.map(function (e) { return { key: e.key, name: e.name, tile: e.tile }; }),
      rows: out
    };
  }

  // ---------------------------------------------------------------------------
  // Names
  // ---------------------------------------------------------------------------
  function nameCfg (i) { return (cfg.names && raw && cfg.names[raw.levels[i].key]) || {}; }
  function headerText (i) { var n = nameCfg(i); return n.header ? fillText(n.header) : raw.levels[i].name; }
  function legendName (i) {
    var n = nameCfg(i);
    if (n.legend) return n.legend;
    return cfg.legend.useHeaders ? headerText(i) : raw.levels[i].name;
  }

  function plural (noun, n) {
    if (n === 1) return noun;
    if (/[^aeiou]y$/i.test(noun)) return noun.slice(0, -1) + 'ies';
    if (/(s|x|ch|sh)$/i.test(noun)) return noun;
    return noun + 's';
  }

  function countNoun () {
    if (cfg.data.countNoun) return cfg.data.countNoun;
    return legendName(raw.levels.length - 1).toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Graph: nodes, edges, which details go where
  // ---------------------------------------------------------------------------
  var autoCache = { rows: null, nulls: null, val: null };

  /**
   * The level each detail field describes: the first level where every node
   * has a single value of it (Schema → Table, Connection → Data Source).
   * Fields that vary everywhere go to the last level.
   */
  function autoLevels () {
    if (autoCache.rows === raw.rows && autoCache.nulls === cfg.data.nulls) return autoCache.val;
    var nL = raw.levels.length;
    var NONE = '\u0000';
    var val = raw.extras.map(function (x, j) {
      // an empty value counts as a value: "sheet" on some views of a table doesn't describe the table
      for (var L = 0; L < nL; L++) {
        var seen = {};
        var ok = true;
        var any = false;
        for (var r = 0; r < raw.rows.length && ok; r++) {
          var row = raw.rows[r];
          var lab = row[0][L];
          if (lab == null) continue;
          var v = row[1][j] == null ? NONE : row[1][j];
          if (v !== NONE) any = true;
          if (Object.prototype.hasOwnProperty.call(seen, lab)) { if (seen[lab] !== v) ok = false; } else seen[lab] = v;
        }
        if (ok && any) return L;
      }
      return nL - 1;
    });
    autoCache = { rows: raw.rows, nulls: cfg.data.nulls, val: val };
    return val;
  }

  function detailCfg (j) {
    var d = (cfg.details && cfg.details[raw.extras[j].key]) || {};
    var lvl = d.level == null || d.level === 'auto' ? autoLevels()[j] : Math.min(raw.levels.length - 1, Number(d.level) || 0);
    var show = d.show || (raw.extras[j].tile === 'details' ? 'subtitle' : 'tooltip');
    return { level: lvl, show: show };
  }

  function matchText (s, q) { return String(s).toLowerCase().indexOf(q) >= 0; }

  function buildGraph () {
    var nL = raw.levels.length;
    var showNulls = cfg.data.nulls === 'show';
    var q = state.query.trim().toLowerCase();
    var byId = {};
    var nodes = [];
    var edges = {};
    var edgeList = [];
    var paths = {};
    var rows = [];

    raw.rows.forEach(function (row) {
      var ids = [];
      for (var L = 0; L < nL; L++) {
        var lab = row[0][L];
        if (lab == null) { if (!showNulls) continue; lab = 'Null'; }
        var id = L + SEP + lab;
        var n = byId[id];
        if (!n) {
          n = byId[id] = { id: id, L: L, label: lab, isNull: row[0][L] == null, rows: [], x: {}, ord: 0, y: 0, h: 0 };
          nodes.push(n);
        }
        ids.push(id);
      }
      if (!ids.length) return;
      rows.push({ ids: ids, x: row[1] });
      paths[ids.join(SEP + SEP)] = 1;
    });

    // search: keep only the paths through a matching node ("filter")
    var matches = {};
    if (q) {
      nodes.forEach(function (n) { if (matchText(n.label, q)) matches[n.id] = 1; });
    }
    if (q && cfg.search.mode === 'filter') {
      var keepRows = rows.filter(function (r) { return r.ids.some(function (id) { return matches[id]; }); });
      if (keepRows.length || !Object.keys(matches).length) rows = keepRows;
    }

    // rebuild what the kept rows use
    var used = {};
    rows.forEach(function (r, ri) {
      r.ids.forEach(function (id, k) {
        var n = byId[id];
        if (!used[id]) { used[id] = 1; n.rows = []; }
        n.rows.push(ri);
        if (k > 0) {
          var ek = r.ids[k - 1] + SEP + SEP + id;
          var e = edges[ek];
          if (!e) { e = edges[ek] = { key: ek, a: byId[r.ids[k - 1]], b: n, rows: [] }; edgeList.push(e); }
          e.rows.push(ri);
        }
      });
    });
    nodes = nodes.filter(function (n) { return used[n.id]; });

    // details per node: distinct values of the fields that describe its level
    var dcfg = raw.extras.map(function (x, j) { return detailCfg(j); });
    rows.forEach(function (r) {
      r.ids.forEach(function (id) {
        var n = byId[id];
        dcfg.forEach(function (d, j) {
          if (d.level !== n.L) return;
          var v = r.x[j];
          if (v == null) return;
          var s = n.x[j] || (n.x[j] = {});
          s[v] = 1;
        });
      });
    });

    // last-level items each node feeds
    var last = nL - 1;
    nodes.forEach(function (n) {
      var leaf = {};
      n.rows.forEach(function (ri) {
        var ids = rows[ri].ids;
        var t = ids[ids.length - 1];
        if (byId[t].L === last) leaf[t] = 1;
      });
      n.count = Object.keys(leaf).length;
    });

    var cols = [];
    for (var L = 0; L < nL; L++) cols.push([]);
    nodes.forEach(function (n) { cols[n.L].push(n); });

    var allPaths = {};
    rows.forEach(function (r) { allPaths[r.ids.join(SEP + SEP)] = 1; });

    return {
      nodes: nodes, byId: byId, edges: edgeList, rows: rows, cols: cols, dcfg: dcfg,
      matches: matches, query: q, pathCount: Object.keys(allPaths).length
    };
  }

  // ---------------------------------------------------------------------------
  // Order inside each column: fewest crossings (barycenter sweeps), by name or by paths
  // ---------------------------------------------------------------------------
  function byName (a, b) { return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' }); }

  function orderColumns (g) {
    var mode = cfg.data.sort;
    var cols = g.cols;
    var renum = function (col) { col.forEach(function (n, i) { n.ord = i; }); };
    cols.forEach(function (col) {
      col.sort(mode === 'name' ? byName : function (a, b) { return b.rows.length - a.rows.length || byName(a, b); });
      renum(col);
    });
    if (mode !== 'flow' || cols.length < 2) return;

    var nbrs = {};
    g.nodes.forEach(function (n) { nbrs[n.id] = { left: [], right: [] }; });
    g.edges.forEach(function (e) {
      nbrs[e.b.id].left.push([e.a, e.rows.length]);
      nbrs[e.a.id].right.push([e.b, e.rows.length]);
    });
    var bary = function (n, side) {
      var list = nbrs[n.id][side];
      if (!list.length) return null;
      var s = 0; var w = 0;
      list.forEach(function (x) { s += x[0].ord * x[1]; w += x[1]; });
      return s / w;
    };
    var sortCol = function (col, side) {
      var keyed = col.map(function (n) { var b = bary(n, side); return { n: n, k: b == null ? n.ord : b }; });
      keyed.sort(function (a, b) { return a.k - b.k || a.n.ord - b.n.ord; });
      keyed.forEach(function (x, i) { col[i] = x.n; });
      renum(col);
    };
    for (var it = 0; it < 4; it++) {
      for (var L = 1; L < cols.length; L++) sortCol(cols[L], 'left');
      for (var R = cols.length - 2; R >= 0; R--) sortCol(cols[R], 'right');
    }
    for (var L2 = 1; L2 < cols.length; L2++) sortCol(cols[L2], 'left');
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg) return;
    if (!raw) return;
    lastSize = el.card.clientWidth + 'x' + el.card.clientHeight;
    el.card.classList.remove('is-empty');
    el.hint.innerHTML = '';
    hideTooltip();

    graph = buildGraph();
    if (state.sel && !graph.byId[state.sel]) state.sel = null;
    if (state.hover && !graph.byId[state.hover]) state.hover = null;
    orderColumns(graph);

    paintCard();
    paintHeader();
    paintTools();
    layoutAndDraw();
    applyHighlight();
  }

  function applyFont (node, f) {
    node.style.fontFamily = Dl.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function cardBg () {
    var c = cfg.card;
    if (c.plotBgOpacity > 0) return Dl.rgba(c.plotBg, c.plotBgOpacity / 100);
    if (c.bgOpacity > 0) return Dl.rgba(c.bgColor, c.bgOpacity / 100);
    return '#FFFFFF';
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Dl.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.plot.style.marginTop = c.gap + 'px';
    el.plot.style.backgroundColor = c.plotBgOpacity > 0 ? Dl.rgba(c.plotBg, c.plotBgOpacity / 100) : 'transparent';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';
    var iconH = 0;
    if (showIcon) {
      var t = Math.max(8, Math.min(128, Number(ic.size) || 24));
      if (ic.source === 'builtin') {
        var r = Dl.iconHtml(ic.builtinId, ic.color, t);
        el.icon.innerHTML = r.html;
        iconH = r.h;
      } else {
        var iw = ic.w || 1; var ih = ic.h || 1;
        var W = iw >= ih ? t : Math.max(1, Math.round(t * iw / ih));
        var H = iw >= ih ? Math.max(1, Math.round(t * ih / iw)) : t;
        if (ic.mask) {
          var mk = 'url(' + ic.dataUrl + ') center / contain no-repeat';
          el.icon.innerHTML = '<span style="display:block;width:' + W + 'px;height:' + H + 'px;background-color:' + ic.color +
            ';-webkit-mask:' + mk + ';mask:' + mk + '"></span>';
        } else {
          el.icon.innerHTML = '<img alt="" src="' + ic.dataUrl + '" style="width:' + W + 'px;height:' + H + 'px">';
        }
        iconH = H;
      }
    }

    var ti = cfg.title;
    applyFont(el.title, ti);
    el.title.textContent = fillText(ti.text) || 'Lineage flow';
    el.title.style.textAlign = ti.align || 'left';
    el.title.style.display = ti.show === false ? 'none' : '';

    var ex = cfg.explanation;
    var exText = fillText(ex.text);
    var hasText = ex.show && !!exText;
    applyFont(el.explanation, ex);
    el.explanation.style.textAlign = ti.align || 'left';
    el.explanation.textContent = hasText ? exText : ' ';
    el.explanation.style.display = hasText || ex.reserveSpace ? '' : 'none';

    var head = el.icon.parentNode;
    var headVisible = showIcon || ti.show !== false || hasText || ex.reserveSpace;
    head.style.display = headVisible ? '' : 'none';
    head.classList.toggle('icon-span', hasText && iconH > (el.title.offsetHeight || 19) * 1.5);
  }

  // ---------------------------------------------------------------------------
  // Legend + search
  // ---------------------------------------------------------------------------
  function paintTools () {
    var lg = cfg.legend;
    var L = el.legend;
    L.innerHTML = '';
    L.style.fontFamily = Dl.fontStack(lg.font);
    L.style.fontSize = lg.size + 'px';
    L.style.color = lg.color;
    if (lg.show) {
      raw.levels.forEach(function (f, i) {
        var it = document.createElement('span');
        it.className = 'lg-item';
        var sw = document.createElement('span');
        sw.className = 'lg-sw' + (cfg.nodes.marker === 'circle' ? ' is-circle' : '');
        sw.style.background = Dl.levelCfg(cfg, i).color;
        var tx = document.createElement('span');
        tx.textContent = legendName(i);
        it.append(sw, tx);
        L.appendChild(it);
      });
      if (lg.showSelected) {
        var it2 = document.createElement('span');
        it2.className = 'lg-item';
        var ln = document.createElement('span');
        ln.className = 'lg-line';
        ln.style.borderTopColor = cfg.highlight.color;
        var tx2 = document.createElement('span');
        tx2.textContent = lg.selectedText || 'Selected Node';
        it2.append(ln, tx2);
        L.appendChild(it2);
      }
    }
    // where the legend goes
    var inHeader = lg.position === 'header';
    if (inHeader && L.parentNode !== el.tools) el.tools.insertBefore(L, el.searchbox);
    if (!inHeader && L.parentNode !== el.legendrow) el.legendrow.appendChild(L);
    el.legendrow.classList.toggle('is-on', !inHeader && lg.show);
    el.card.classList.toggle('legend-bottom', lg.position === 'bottom');

    var S = cfg.search;
    el.searchbox.classList.toggle('is-on', !!S.show);
    el.search.placeholder = S.placeholder || '';
    el.search.style.width = Math.max(100, Number(S.width) || 180) + 'px';
    el.tools.classList.toggle('is-empty', !(inHeader && lg.show) && !S.show);
  }

  function onSearch (jump) {
    var q = el.search.value;
    if (q === state.query && !jump) return;
    state.query = q;
    paint();
    var first = graph && graph.nodes.find(function (n) { return graph.matches[n.id]; });
    if (first && first.div) {
      var p = el.plot;
      var top = first.y - p.clientHeight / 3;
      if (jump || first.y < p.scrollTop || first.y > p.scrollTop + p.clientHeight - 40) p.scrollTop = Math.max(0, top);
    }
  }

  // ---------------------------------------------------------------------------
  // Layout: columns side by side, nodes measured by the browser, then placed
  // next to the nodes they link to (relaxation, keeping the column order)
  // ---------------------------------------------------------------------------
  function layoutAndDraw () {
    var g = graph;
    var N = cfg.nodes;
    var nL = g.cols.length;
    var H = cfg.headers;

    // headers
    el.headers.innerHTML = '';
    el.headers.style.background = cardBg();
    var hdrH = 0;
    if (H.show) {
      hdrH = Math.round(H.size * 1.4 + 12);
      el.headers.style.height = hdrH + 'px';
    }
    el.headers.style.display = hdrH ? '' : 'none';

    // columns
    var plotW = el.plot.clientWidth;
    var gapMin = Math.max(16, Number(cfg.links.minSpace) || 48);
    var minW = Math.max(60, Number(N.minWidth) || 140);
    var maxW = Math.max(minW, Number(N.maxWidth) || 240);
    var nw = nL > 1 ? (plotW - (nL - 1) * gapMin) / nL : plotW;
    nw = Math.max(minW, Math.min(maxW, Math.floor(nw)));
    var step = nL > 1 ? Math.max(nw + gapMin, (plotW - nw) / (nL - 1)) : 0;
    var width = nL > 1 ? Math.ceil(step * (nL - 1) + nw) : Math.max(nw, plotW);
    if (nL === 1) nw = Math.min(maxW, plotW);
    var colX = g.cols.map(function (c, i) { return Math.round(i * step); });

    if (H.show) {
      g.cols.forEach(function (c, i) {
        var d = document.createElement('div');
        d.className = 'hdr';
        applyFont(d, H);
        d.style.left = colX[i] + 'px';
        d.style.width = (i === nL - 1 ? nw : Math.min(step, nw + gapMin) - 8) + 'px';
        d.style.textTransform = H.uppercase ? 'uppercase' : 'none';
        d.style.letterSpacing = (Number(H.spacing) || 0) + 'em';
        d.style.lineHeight = hdrH - 8 + 'px';
        d.textContent = headerText(i);
        el.headers.appendChild(d);
      });
      el.headers.style.width = width + 'px';
    }

    // nodes: build, then measure every height in one go
    var box = el.nodes;
    box.innerHTML = '';
    var frag = document.createDocumentFragment();
    var hlBorder = Math.max(N.borderWidth, 1);
    g.nodes.forEach(function (n) {
      var d = nodeDiv(n, nw);
      d.style.left = colX[n.L] + 'px';
      d.style.borderWidth = hlBorder + 'px';
      n.div = d;
      frag.appendChild(d);
    });
    box.appendChild(frag);
    g.nodes.forEach(function (n) { n.h = n.div.offsetHeight; });

    // vertical placement
    var gap = Math.max(0, Number(N.gap) || 0);
    var stack = function (col) {
      var y = 0;
      col.forEach(function (n) { n.y = y; y += n.h + gap; });
    };
    g.cols.forEach(stack);
    var nbr = {};
    g.nodes.forEach(function (n) { nbr[n.id] = { left: [], right: [] }; });
    g.edges.forEach(function (e) {
      nbr[e.b.id].left.push(e.a);
      nbr[e.a.id].right.push(e.b);
    });
    var center = function (n) { return n.y + n.h / 2; };
    // like d3-sankey: move each node towards the centre of its neighbours, then
    // resolve overlaps inside [0, tallest column] keeping the column order
    var limit = 0;
    g.cols.forEach(function (col) { var last = col[col.length - 1]; if (last) limit = Math.max(limit, last.y + last.h); });
    var resolve = function (col) {
      var prev = 0;
      col.forEach(function (n) { if (n.y < prev) n.y = prev; prev = n.y + n.h + gap; });
      var lim = limit;
      for (var i = col.length - 1; i >= 0; i--) {
        var n = col[i];
        if (n.y + n.h > lim) n.y = lim - n.h;
        lim = n.y - gap;
      }
      prev = 0;
      col.forEach(function (n) { if (n.y < prev) n.y = prev; prev = n.y + n.h + gap; });
    };
    var place = function (col, side, alpha) {
      col.forEach(function (n) {
        var list = nbr[n.id][side];
        if (!list.length) return;
        var s = 0;
        list.forEach(function (m) { s += center(m); });
        n.y += (s / list.length - n.h / 2 - n.y) * alpha;
      });
      resolve(col);
    };
    if (nL > 1 && N.align !== 'top') {
      for (var it = 0, alpha = 1; it < 8; it++, alpha *= 0.85) {
        for (var L = 1; L < nL; L++) place(g.cols[L], 'left', alpha);
        for (var R = nL - 2; R >= 0; R--) place(g.cols[R], 'right', alpha);
      }
    }
    var height = 0;
    g.nodes.forEach(function (n) {
      n.x = colX[n.L];
      n.w = nw;
      n.div.style.top = n.y + 'px';
      height = Math.max(height, n.y + n.h);
    });

    el.canvas.style.width = width + 'px';
    el.canvas.style.height = (height + 4) + 'px';
    el.svg.setAttribute('width', width);
    el.svg.setAttribute('height', height + 4);

    if (!g.nodes.length) {
      var em = document.createElement('div');
      em.className = 'empty-filter';
      em.textContent = graph.query ? 'Nothing matches “' + state.query.trim() + '”.' : 'No paths to show.';
      box.appendChild(em);
    }

    drawLinks();
  }

  function nodeDiv (n, w) {
    var N = cfg.nodes;
    var lc = Dl.levelCfg(cfg, n.L);
    var d = document.createElement('div');
    d.className = 'node' + (lc.subPos === 'above' ? ' sub-above' : '');
    d.dataset.id = n.id;
    d.style.width = w + 'px';
    d.style.padding = N.padY + 'px ' + N.padX + 'px';
    d.style.borderRadius = N.radius + 'px';
    d.style.background = N.bg;
    d.style.borderColor = N.border;
    if (N.marker !== 'none') {
      var mk = document.createElement('span');
      mk.className = 'mk';
      var ms = Math.max(4, Number(N.markerSize) || 8);
      mk.style.width = ms + 'px';
      mk.style.height = ms + 'px';
      mk.style.borderRadius = N.marker === 'circle' ? '50%' : '2px';
      mk.style.background = lc.color;
      d.appendChild(mk);
    }
    var tx = document.createElement('div');
    tx.className = 'tx';
    var nm = document.createElement('div');
    nm.className = 'nm';
    nm.style.fontFamily = lc.mono ? Dl.MONO_STACK : Dl.fontStack(N.font);
    nm.style.fontSize = (lc.mono ? Math.max(6, N.size - 1) : N.size) + 'px';
    nm.style.fontWeight = String(N.weight);
    nm.style.color = N.color;
    nm.style.webkitLineClamp = String(Math.max(1, Number(N.maxLines) || 1));
    nm.textContent = n.label;
    if (lc.mono) nm.classList.add('is-mono');
    var subs = [];
    var inl = [];
    graph.dcfg.forEach(function (dc, j) {
      if (dc.level !== n.L || !n.x[j]) return;
      var vals = Object.keys(n.x[j]);
      var text = vals.length === 1 ? vals[0] : vals.length + ' ' + plural(raw.extras[j].name.toLowerCase(), vals.length);
      if (dc.show === 'subtitle') subs.push(text);
      else if (dc.show === 'inline') inl.push(text);
    });
    if (lc.count && n.L < raw.levels.length - 1 && n.count) subs.push(n.count + ' ' + plural(countNoun(), n.count));
    if (inl.length) {
      var s = document.createElement('span');
      s.className = 'inl';
      s.style.color = N.subColor;
      s.style.fontFamily = Dl.fontStack(N.subFont);
      s.style.fontSize = N.subSize + 'px';
      s.textContent = '  · ' + inl.join(' · ');
      nm.appendChild(s);
    }
    tx.appendChild(nm);
    if (subs.length) {
      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.style.fontFamily = lc.mono && lc.subPos === 'above' ? Dl.MONO_STACK : Dl.fontStack(N.subFont);
      sub.style.fontSize = N.subSize + 'px';
      sub.style.fontWeight = String(N.subWeight);
      sub.style.color = N.subColor;
      sub.textContent = subs.join(' · ');
      tx.appendChild(sub);
    }
    d.appendChild(tx);
    return d;
  }

  function linkPath (e) {
    var x1 = e.a.x + e.a.w;
    var y1 = e.a.y + e.a.h / 2;
    var x2 = e.b.x;
    var y2 = e.b.y + e.b.h / 2;
    var c = cfg.links.curve;
    var f = function (v) { return Math.round(v * 10) / 10; };
    if (c === 'straight') return 'M' + f(x1) + ',' + f(y1) + 'L' + f(x2) + ',' + f(y2);
    if (c === 'step') {
      var mx = f(x1 + Math.min(24, (x2 - x1) / 2));
      if (Math.abs(y2 - y1) < 1) return 'M' + f(x1) + ',' + f(y1) + 'H' + f(x2);
      var r = Math.min(6, Math.abs(y2 - y1) / 2, (x2 - x1) / 4);
      var dir = y2 > y1 ? 1 : -1;
      return 'M' + f(x1) + ',' + f(y1) + 'H' + f(mx - r) + 'Q' + mx + ',' + f(y1) + ' ' + mx + ',' + f(y1 + dir * r) +
        'V' + f(y2 - dir * r) + 'Q' + mx + ',' + f(y2) + ' ' + f(mx + r) + ',' + f(y2) + 'H' + f(x2);
    }
    var dx = (x2 - x1) / 2;
    return 'M' + f(x1) + ',' + f(y1) + 'C' + f(x1 + dx) + ',' + f(y1) + ' ' + f(x2 - dx) + ',' + f(y2) + ' ' + f(x2) + ',' + f(y2);
  }

  var litGroup = null;
  var baseGroup = null;
  function drawLinks () {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var LK = cfg.links;
    baseGroup = document.createElementNS(SVGNS, 'g');
    baseGroup.setAttribute('class', 'base');
    baseGroup.setAttribute('stroke', LK.color);
    baseGroup.setAttribute('stroke-width', LK.width);
    baseGroup.setAttribute('stroke-opacity', Math.max(0, Math.min(100, LK.opacity)) / 100);
    graph.edges.forEach(function (e) {
      var p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', linkPath(e));
      e.path = p;
      baseGroup.appendChild(p);
    });
    litGroup = document.createElementNS(SVGNS, 'g');
    litGroup.setAttribute('class', 'lit');
    litGroup.setAttribute('stroke', cfg.highlight.color);
    litGroup.setAttribute('stroke-width', cfg.highlight.width);
    svg.append(baseGroup, litGroup);
  }

  // ---------------------------------------------------------------------------
  // Highlight: the selected (or hovered) node's lineage, and search matches
  // ---------------------------------------------------------------------------
  function lineage (ids) {
    var rows = {};
    ids.forEach(function (id) { var n = graph.byId[id]; if (n && n.rows) n.rows.forEach(function (r) { rows[r] = 1; }); });
    var nodes = {};
    Object.keys(rows).forEach(function (r) { graph.rows[r].ids.forEach(function (id) { nodes[id] = 1; }); });
    return { rows: rows, nodes: nodes };
  }

  function edgeLit (e, rows) {
    for (var i = 0; i < e.rows.length; i++) if (rows[e.rows[i]]) return true;
    return false;
  }

  function applyHighlight () {
    if (!graph || !litGroup) return;
    var HL = cfg.highlight;
    var N = cfg.nodes;
    var matchIds = Object.keys(graph.matches);
    var focus = state.sel ? [state.sel]
      : (HL.hover && state.hover ? [state.hover]
        : (graph.query && cfg.search.mode === 'highlight' ? matchIds : []));
    var lin = focus.length ? lineage(focus) : null;
    var fade = lin && HL.fade !== 'none' ? HL.fade : null;
    el.card.style.setProperty('--fade', String(Math.max(0, Math.min(100, HL.fadeOpacity)) / 100));
    el.card.style.setProperty('--match', HL.matchColor);

    graph.nodes.forEach(function (n) {
      var d = n.div;
      if (!d) return;
      var on = !!(lin && lin.nodes[n.id]);
      var isSel = state.sel === n.id;
      d.style.background = on ? HL.nodeBg : N.bg;
      d.style.borderColor = on ? HL.nodeBorder : N.border;
      d.style.boxShadow = isSel ? '0 0 0 1px ' + HL.nodeBorder : '';
      var nm = d.querySelector('.nm');
      if (nm) nm.style.fontWeight = on && HL.boldTitle ? '700' : String(N.weight);
      d.classList.toggle('is-match', !!graph.matches[n.id] && !!graph.query);
      if (isSel) d.style.boxShadow = '0 0 0 1px ' + HL.nodeBorder;
      if (graph.matches[n.id] && graph.query) d.style.boxShadow = '0 0 0 2px ' + HL.matchColor;
      d.classList.toggle('is-faded', fade === 'fade' && !on);
      d.classList.toggle('is-hidden', fade === 'hide' && !on);
    });

    while (litGroup.firstChild) litGroup.removeChild(litGroup.firstChild);
    graph.edges.forEach(function (e) {
      var on = !!(lin && edgeLit(e, lin.rows));
      e.path.setAttribute('class', !lin || on ? '' : (fade === 'fade' ? 'is-faded' : fade === 'hide' ? 'is-hidden' : ''));
      if (on) {
        var p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', e.path.getAttribute('d'));
        litGroup.appendChild(p);
      }
    });
  }

  function setHover (id) {
    if (state.hover === id) return;
    state.hover = id;
    if (!state.sel && cfg && cfg.highlight.hover) applyHighlight();
  }

  // ---------------------------------------------------------------------------
  // Mouse
  // ---------------------------------------------------------------------------
  function nodeFromEvent (e) {
    var d = e.target && e.target.closest ? e.target.closest('.node') : null;
    return d && graph ? graph.byId[d.dataset.id] : null;
  }

  function onHover (e) {
    var n = nodeFromEvent(e);
    setHover(n ? n.id : null);
    if (n && cfg.tooltip.show) showTooltip(n, e.clientX, e.clientY); else hideTooltip();
  }

  function onClick (e) {
    if (e.detail > 1) return;
    var n = nodeFromEvent(e);
    hideMenu();
    select(n && state.sel !== n.id ? n : null);
  }

  function onDblClick (e) {
    var n = nodeFromEvent(e);
    if (!n || cfg.interaction.dblclick !== 'format') return;
    openDialog({ tab: 'levels', item: n.L });
  }

  function select (n) {
    state.sel = n ? n.id : null;
    applyHighlight();
    if (!cfg.interaction.selectInTableau) return;
    if (n && !n.isNull) selectInTableau(n); else clearTableauSelection();
  }

  /** Selects the node's value in Tableau (for dashboard actions). Silently skipped if not supported. */
  function selectInTableau (n) {
    try {
      if (!worksheet || !worksheet.selectMarksByValueAsync) return;
      var f = raw.levels[n.L];
      var type = tableau.SelectionUpdateType ? tableau.SelectionUpdateType.Replace : 'select-replace';
      worksheet.selectMarksByValueAsync([{ fieldName: f.key, value: [n.label] }], type)
        .catch(function (err) { console.info('Data Lineage: selection not applied', err && err.message); });
    } catch (e) { /* not supported */ }
  }

  function clearTableauSelection () {
    try { if (worksheet && worksheet.clearSelectedMarksAsync) worksheet.clearSelectedMarksAsync().catch(function () {}); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showTooltip (n, x, y) {
    var T = cfg.tooltip;
    var lc = Dl.levelCfg(cfg, n.L);
    var html = '<div class="tt-level"><span class="lg-sw" style="background:' + lc.color + '"></span>' + esc(headerText(n.L)) + '</div>' +
      '<div class="tt-name">' + esc(n.label) + '</div>';
    var rows = [];
    if (T.showDetails) {
      graph.dcfg.forEach(function (dc, j) {
        if (dc.show === 'hidden') return;
        var vals = {};
        if (dc.level === n.L) vals = n.x[j] || {};
        else if (dc.show === 'tooltip' || raw.extras[j].tile !== 'details') {
          n.rows.forEach(function (ri) { var v = graph.rows[ri].x[j]; if (v != null) vals[v] = 1; });
        } else return;
        var list = Object.keys(vals);
        if (!list.length) return;
        rows.push([raw.extras[j].name, list.length <= 3 ? list.join(', ') : list.length + ' values']);
      });
    }
    if (rows.length) html += '<div class="tt-rows">' + rows.map(function (r) { return '<div class="tt-row"><span class="nm">' + esc(r[0]) + '</span><span class="vl">' + esc(r[1]) + '</span></div>'; }).join('') + '</div>';
    if (T.showCounts && raw.levels.length > 1) {
      var lin = lineage([n.id]);
      var per = raw.levels.map(function () { return 0; });
      Object.keys(lin.nodes).forEach(function (id) { var m = graph.byId[id]; if (m && m.id !== n.id) per[m.L]++; });
      var up = []; var down = [];
      per.forEach(function (c, L) {
        if (!c) return;
        var t = '<div class="tt-row"><span class="nm">' + esc(legendName(L)) + '</span><span class="vl">' + c.toLocaleString('en-US') + '</span></div>';
        (L < n.L ? up : down).push(t);
      });
      if (up.length) html += '<div class="tt-rows"><div class="tt-sec">Upstream</div>' + up.join('') + '</div>';
      if (down.length) html += '<div class="tt-rows"><div class="tt-sec">Downstream</div>' + down.join('') + '</div>';
      html += '<div class="tt-hint">' + n.rows.length.toLocaleString('en-US') + ' path' + (n.rows.length === 1 ? '' : 's') +
        ' · click to ' + (state.sel === n.id ? 'clear' : 'select') + '</div>';
    }
    var t = el.tooltip;
    t.innerHTML = html;
    t.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var w = t.offsetWidth; var h = t.offsetHeight;
    var left = x + 14; var top = y + 14;
    if (left + w > vw - 4) left = Math.max(4, x - w - 14);
    if (top + h > vh - 4) top = Math.max(4, y - h - 14);
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  function hideTooltip () { if (el.tooltip) el.tooltip.style.display = 'none'; }

  // ---------------------------------------------------------------------------
  // Right-click menu
  // ---------------------------------------------------------------------------
  function onContextMenu (e) {
    if (!cfg || !cfg.interaction.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    var n = nodeFromEvent(e);
    var items = [];
    if (n) {
      items.push({ head: headerText(n.L) + ' · ' + n.label });
      items.push(state.sel === n.id ? ['Clear selection', function () { select(null); }] : ['Select lineage', function () { select(n); }]);
      items.push(['Search for “' + (n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label) + '”', function () {
        el.search.value = n.label; onSearch(true);
      }]);
      items.push(['Format level “' + headerText(n.L) + '”…', function () { openDialog({ tab: 'levels', item: n.L }); }]);
      items.push(null);
    } else if (state.sel) {
      items.push(['Clear selection', function () { select(null); }], null);
    }
    if (state.query) items.push(['Clear search', function () { el.search.value = ''; onSearch(); }], null);
    items.push(['Levels & details…', function () { openDialog({ tab: 'levels' }); }],
      ['Nodes…', function () { openDialog({ tab: 'nodes' }); }],
      ['Links & highlight…', function () { openDialog({ tab: 'links' }); }],
      ['Headers & legend…', function () { openDialog({ tab: 'legend' }); }],
      null,
      ['Format extension…', function () { openDialog(null); }]);

    var m = el.menu;
    m.innerHTML = '';
    var prevSep = true;
    items.forEach(function (it) {
      if (!it) { if (!prevSep) m.appendChild(document.createElement('hr')); prevSep = true; return; }
      prevSep = false;
      if (it.head) { var h = document.createElement('div'); h.className = 'menu-head'; h.textContent = it.head; m.appendChild(h); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () { hideMenu(); it[1](); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.max(2, Math.min(e.clientX, vw - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(2, Math.min(e.clientY, vh - m.offsetHeight - 4)) + 'px';
  }

  function hideMenu () { if (el.menu) el.menu.style.display = 'none'; }

  // ---------------------------------------------------------------------------
  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.DataLineage = { init: init, _state: state, _graph: function () { return graph; } };
})();
