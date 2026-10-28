'use strict';

/**
 * Format dialog for the Data Lineage extension ("Format Extension" on the
 * Marks card, or the chart's right-click menu).
 *
 * Every change shows in the chart at once (live preview) and is saved a
 * moment later. Cancel restores what was stored on open. The chart passes its
 * level and detail fields as the dialog payload, because a dialog can't read
 * the worksheet.
 *
 * The Icon, Title & text, Card and Presets tabs are copied from Bar Chart.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var activeTab = 'levels';
  var info = { liveId: null, focus: null, levels: [], extras: [], params: [], pathCount: 0 };
  var openLevel = 0; // level whose card is open in the Levels tab

  var WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']];

  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'levels', label: 'Levels & details', build: buildLevelsTab, keys: ['levels', 'names', 'details', 'data'] },
    { id: 'nodes', label: 'Nodes', build: buildNodesTab, keys: ['nodes'] },
    { id: 'links', label: 'Links & highlight', build: buildLinksTab, keys: ['links', 'highlight'] },
    { id: 'legend', label: 'Headers & legend', build: buildLegendTab, keys: ['headers', 'legend'] },
    { id: 'search', label: 'Search & actions', build: buildSearchTab, keys: ['search', 'tooltip', 'interaction'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var p = JSON.parse(payload || '{}');
        Object.keys(info).forEach(function (k) { if (p[k] != null) info[k] = p[k]; });
      } catch (e) { /* opened without payload */ }

      cfg = Dl.read();
      original = Dl.clone(cfg);

      if (info.focus && info.focus.tab && TABS.some(function (t) { return t.id === info.focus.tab; })) activeTab = info.focus.tab;
      if (info.focus && info.focus.item != null) openLevel = Number(info.focus.item) || 0;

      buildTabs();
      window.addEventListener('storage', onChartInfo);
      document.getElementById('cancel').addEventListener('click', function () {
        cfg = original;
        flush().then(close);
      });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Data Lineage dialog failed to initialize:', err);
    });
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    var scroll = panels.scrollTop;
    nav.innerHTML = '';
    panels.innerHTML = '';

    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; panels.scrollTop = 0; buildTabs(); });
      nav.appendChild(b);

      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
    panels.scrollTop = scroll;
  }

  function rebuild () { buildTabs(); }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) {
      var path = k.split('.');
      var def = path.reduce(function (o, x) { return o == null ? undefined : o[x]; }, Dl.DEFAULTS);
      var last = path.pop();
      var tgt = path.reduce(function (o, x) { return o[x]; }, cfg);
      tgt[last] = Dl.clone(def);
    });
    cfg = Dl.normalize(cfg);
    changed();
    buildTabs();
  }

  function help (text) { return h('div', { className: 'help', textContent: text }); }

  /** Path helper: P('a.b', 'c.d') or P(['names', key], 'header') → array. */
  function P (base, rest) {
    var a = Array.isArray(base) ? base.slice() : String(base).split('.');
    return rest == null ? a : a.concat(String(rest).split('.'));
  }

  // ---------------------------------------------------------------------------
  // Levels & details
  // ---------------------------------------------------------------------------
  function levelList () {
    if (info.levels.length) return info.levels;
    // opened without the chart (no payload): the six level slots
    return cfg.levels.map(function (l, i) { return { key: null, name: 'Level ' + (i + 1), count: 0 }; });
  }

  function buildLevelsTab (p) {
    var levels = levelList();
    var g = group(p, 'Levels (columns)');
    g.appendChild(help(info.levels.length
      ? 'One column per field on the Levels tile, in tile order. ' + (info.pathCount ? info.pathCount.toLocaleString('en-US') + ' paths.' : '')
      : 'Open this window from the chart to name its fields. Colours apply by position.'));

    levels.forEach(function (lv, i) {
      var card = h('div', { className: 'subcard level-card' + (i === openLevel ? ' is-open' : '') });
      var head = h('button', { type: 'button', className: 'level-head' });
      var sw = h('span', { className: 'role-dot' });
      sw.style.background = cfg.levels[i].color;
      head.append(sw, h('b', { textContent: lv.name }), h('span', { className: 'help', textContent: lv.count ? '  ' + lv.count.toLocaleString('en-US') + ' nodes' : '' }));
      head.addEventListener('click', function () { openLevel = openLevel === i ? -1 : i; rebuild(); });
      card.appendChild(head);
      if (i === openLevel) {
        var body = h('div', { className: 'level-body' });
        if (lv.key) {
          body.appendChild(textRow('Column header', ['names', lv.key, 'header'], lv.name));
          body.appendChild(textRow('Legend name', ['names', lv.key, 'legend'], 'Defaults to the field name'));
        }
        body.appendChild(colorRow('Color', ['levels', i, 'color'], function () { sw.style.background = cfg.levels[i].color; }));
        body.appendChild(checkboxRow('Monospace names', ['levels', i, 'mono']));
        body.appendChild(segRow('Subtitle', ['levels', i, 'subPos'], [['above', 'Above name'], ['below', 'Below name']]));
        if (i < levels.length - 1 || !info.levels.length) {
          body.appendChild(checkboxRow('Show count', ['levels', i, 'count']));
          body.appendChild(help('Adds “9 ' + countNounPreview() + '” to the subtitle: how many last-level items the node feeds.'));
        }
        card.appendChild(body);
        if (info.focus && info.focus.item === i) setTimeout(function () { card.scrollIntoView({ block: 'nearest' }); }, 0);
      }
      g.appendChild(card);
    });

    // details
    var g2 = group(p, 'Details (node subtitles)');
    if (!info.extras.length) {
      g2.appendChild(h('p', { className: 'note', textContent: 'Drop dimensions on the Details tile (schema, connection type, sheet type…) to show them under the node names. Fields on Tableau’s Tooltip tile show in the tooltip.' }));
    } else {
      g2.appendChild(help('“Auto” puts a detail under the first level where each node has a single value of it.'));
      var lvOpts = [['auto', 'Auto']].concat(levels.map(function (l, i) { return [i, l.name]; }));
      info.extras.forEach(function (x) {
        var sub = h('div', { className: 'subcard' });
        sub.appendChild(h('div', { className: 'subcard-title', textContent: x.name + (x.tile === 'tooltip' ? '  (Tooltip tile)' : '') }));
        var cur = (cfg.details[x.key] || {});
        var lvlRow = row('Level');
        var sel = h('select');
        lvOpts.forEach(function (o) {
          var label = o[0] === 'auto' && x.autoLevel != null && levels[x.autoLevel] ? 'Auto (' + levels[x.autoLevel].name + ')' : o[1];
          sel.appendChild(h('option', { value: String(o[0]), textContent: label }));
        });
        sel.value = cur.level == null ? 'auto' : String(cur.level);
        sel.addEventListener('change', function () {
          setDetail(x.key, 'level', sel.value === 'auto' ? 'auto' : Number(sel.value));
        });
        lvlRow.appendChild(sel);
        sub.appendChild(lvlRow);
        var showRow = row('Show as');
        var seg = h('div', { className: 'seg' });
        var curShow = cur.show || (x.tile === 'details' ? 'subtitle' : 'tooltip');
        [['subtitle', 'Subtitle'], ['inline', 'After name'], ['tooltip', 'Tooltip only'], ['hidden', 'Hidden']].forEach(function (o) {
          var b = h('button', { type: 'button', textContent: o[1] });
          b.setAttribute('aria-pressed', String(curShow === o[0]));
          b.addEventListener('click', function () {
            setDetail(x.key, 'show', o[0]);
            Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
            b.setAttribute('aria-pressed', 'true');
          });
          seg.appendChild(b);
        });
        showRow.appendChild(seg);
        sub.appendChild(showRow);
        g2.appendChild(sub);
      });
    }

    var g3 = group(p, 'Data');
    g3.appendChild(selectRow('Order in columns', 'data.sort', [['flow', 'Follow the links (fewest crossings)'], ['paths', 'Most paths first'], ['name', 'Name (A–Z)']]));
    g3.appendChild(selectRow('Empty values', 'data.nulls', [['skip', 'Skip the level (link jumps over it)'], ['show', 'Show a “Null” node']]));
    g3.appendChild(textRow('Count word', 'data.countNoun', 'Defaults to the last level’s name, e.g. views'));
    g3.appendChild(help('Nodes are matched by name within a column: give items that share a name a unique label (e.g. a calculated field with the name and its id).'));
  }

  function countNounPreview () {
    if (cfg.data.countNoun) return cfg.data.countNoun;
    var l = info.levels[info.levels.length - 1];
    if (!l) return 'items';
    var n = (cfg.names[l.key] && cfg.names[l.key].legend) || l.name;
    n = String(n).toLowerCase();
    return /s$/.test(n) ? n : n + 's';
  }

  function setDetail (key, prop, value) {
    var d = cfg.details[key] || (cfg.details[key] = {});
    d[prop] = value;
    changed();
  }

  // ---------------------------------------------------------------------------
  // Nodes
  // ---------------------------------------------------------------------------
  function buildNodesTab (p) {
    var g1 = group(p, 'Size and spacing');
    g1.appendChild(segRow('Placement', 'nodes.align', [['flow', 'Next to linked nodes'], ['top', 'From the top']]));
    g1.appendChild(numberRow('Min width (px)', 'nodes.minWidth', 60, 600, 5));
    g1.appendChild(numberRow('Max width (px)', 'nodes.maxWidth', 60, 800, 5));
    g1.appendChild(help('Nodes fill their column between these widths. Below the minimum the chart scrolls sideways.'));
    g1.appendChild(rangeRow('Space between', 'nodes.gap', 0, 40, 1, ' px'));
    g1.appendChild(rangeRow('Padding left/right', 'nodes.padX', 2, 30, 1, ' px'));
    g1.appendChild(rangeRow('Padding top/bottom', 'nodes.padY', 0, 20, 1, ' px'));
    g1.appendChild(numberRow('Name lines (max)', 'nodes.maxLines', 1, 4, 1));

    var g2 = group(p, 'Box');
    g2.appendChild(colorRow('Background', 'nodes.bg'));
    g2.appendChild(colorRow('Border', 'nodes.border'));
    g2.appendChild(rangeRow('Border width', 'nodes.borderWidth', 0, 4, 0.5, ' px'));
    g2.appendChild(rangeRow('Corner radius', 'nodes.radius', 0, 16, 1, ' px'));
    g2.appendChild(segRow('Level marker', 'nodes.marker', [['square', 'Square'], ['circle', 'Circle'], ['none', 'None']]));
    g2.appendChild(rangeRow('Marker size', 'nodes.markerSize', 4, 16, 1, ' px'));

    var g3 = group(p, 'Name');
    g3.appendChild(fontFamilyRow('Font', 'nodes.font'));
    g3.appendChild(numberRow('Size (px)', 'nodes.size', 8, 30, 1));
    g3.appendChild(selectRow('Weight', 'nodes.weight', WEIGHTS));
    g3.appendChild(colorRow('Color', 'nodes.color'));

    var g4 = group(p, 'Subtitle');
    g4.appendChild(fontFamilyRow('Font', 'nodes.subFont'));
    g4.appendChild(numberRow('Size (px)', 'nodes.subSize', 7, 24, 1));
    g4.appendChild(selectRow('Weight', 'nodes.subWeight', WEIGHTS));
    g4.appendChild(colorRow('Color', 'nodes.subColor'));
  }

  // ---------------------------------------------------------------------------
  // Links & highlight
  // ---------------------------------------------------------------------------
  function buildLinksTab (p) {
    var g1 = group(p, 'Links');
    g1.appendChild(segRow('Shape', 'links.curve', [['bezier', 'Curved'], ['step', 'Elbow'], ['straight', 'Straight']]));
    g1.appendChild(colorRow('Color', 'links.color'));
    g1.appendChild(rangeRow('Width', 'links.width', 0.5, 5, 0.1, ' px'));
    g1.appendChild(rangeRow('Opacity', 'links.opacity', 10, 100, 1, '%'));
    g1.appendChild(rangeRow('Min space between columns', 'links.minSpace', 16, 160, 2, ' px'));

    var g2 = group(p, 'Selected lineage');
    g2.appendChild(help('Click a node: every path through it is highlighted. Click it again, or empty space, to clear.'));
    g2.appendChild(colorRow('Link color', 'highlight.color'));
    g2.appendChild(rangeRow('Link width', 'highlight.width', 0.5, 6, 0.1, ' px'));
    g2.appendChild(colorRow('Node background', 'highlight.nodeBg'));
    g2.appendChild(colorRow('Node border', 'highlight.nodeBorder'));
    g2.appendChild(checkboxRow('Bold names', 'highlight.boldTitle'));
    g2.appendChild(segRow('Other nodes', 'highlight.fade', [['none', 'Keep'], ['fade', 'Fade'], ['hide', 'Hide']]));
    g2.appendChild(rangeRow('Faded opacity', 'highlight.fadeOpacity', 5, 90, 1, '%'));
    g2.appendChild(checkboxRow('Preview on hover', 'highlight.hover'));
    g2.appendChild(help('Hovering a node shows its lineage while nothing is selected.'));
    g2.appendChild(colorRow('Search match outline', 'highlight.matchColor'));
  }

  // ---------------------------------------------------------------------------
  // Headers & legend
  // ---------------------------------------------------------------------------
  function buildLegendTab (p) {
    var g1 = group(p, 'Column headers');
    g1.appendChild(checkboxRow('Show headers', 'headers.show'));
    g1.appendChild(fontFamilyRow('Font', 'headers.font'));
    g1.appendChild(numberRow('Size (px)', 'headers.size', 7, 24, 1));
    g1.appendChild(selectRow('Weight', 'headers.weight', WEIGHTS));
    g1.appendChild(colorRow('Color', 'headers.color'));
    g1.appendChild(checkboxRow('Uppercase', 'headers.uppercase'));
    g1.appendChild(rangeRow('Letter spacing', 'headers.spacing', 0, 0.3, 0.01, ' em'));
    g1.appendChild(help('Header texts are set per level in Levels & details.'));

    var g2 = group(p, 'Legend');
    g2.appendChild(checkboxRow('Show legend', 'legend.show'));
    g2.appendChild(segRow('Position', 'legend.position', [['header', 'Next to title'], ['top', 'Above chart'], ['bottom', 'Below chart']]));
    g2.appendChild(segRow('Names', 'legend.useHeaders', [[false, 'Field names'], [true, 'Column headers']]));
    g2.appendChild(checkboxRow('Show “selected” item', 'legend.showSelected'));
    g2.appendChild(textRow('Selected text', 'legend.selectedText', 'Selected Node'));
    g2.appendChild(fontFamilyRow('Font', 'legend.font'));
    g2.appendChild(numberRow('Size (px)', 'legend.size', 7, 24, 1));
    g2.appendChild(colorRow('Color', 'legend.color'));
  }

  // ---------------------------------------------------------------------------
  // Search & actions
  // ---------------------------------------------------------------------------
  function buildSearchTab (p) {
    var g1 = group(p, 'Search box');
    g1.appendChild(checkboxRow('Show search box', 'search.show'));
    g1.appendChild(textRow('Placeholder', 'search.placeholder', 'Search nodes…'));
    g1.appendChild(segRow('Matches', 'search.mode', [['highlight', 'Highlight lineage'], ['filter', 'Show only their lineage']]));
    g1.appendChild(numberRow('Width (px)', 'search.width', 100, 400, 10));
    g1.appendChild(help('Typing finds nodes by name (any column). Enter scrolls to the first match; Esc clears.'));

    var g2 = group(p, 'Tooltip');
    g2.appendChild(checkboxRow('Show tooltip', 'tooltip.show'));
    g2.appendChild(checkboxRow('Details', 'tooltip.showDetails'));
    g2.appendChild(checkboxRow('Upstream / downstream counts', 'tooltip.showCounts'));

    var g3 = group(p, 'Actions');
    g3.appendChild(checkboxRow('Select in Tableau', 'interaction.selectInTableau'));
    g3.appendChild(help('Clicking a node selects its value in the worksheet, so dashboard filter and highlight actions follow it.'));
    g3.appendChild(checkboxRow('Right-click menu', 'interaction.rightClickMenu'));
    g3.appendChild(segRow('Double-click a node', 'interaction.dblclick', [['format', 'Format its level'], ['none', 'Nothing']]));
    g3.appendChild(segRow('Format window', 'interaction.dialog', [['onTop', 'On top of Tableau'], ['floating', 'Floating']]));
    g3.appendChild(help('On top keeps this window in front of Tableau until Done. Floating lets you click the workbook, but the window can go behind Tableau. Takes effect the next time it opens.'));
  }

  // ---------------------------------------------------------------------------
  // Title & text, Card (Bar Chart's)
  // ---------------------------------------------------------------------------
  function buildTextTab (p) {
    var g1 = group(p, 'Title');
    g1.appendChild(checkboxRow('Show title', 'title.show'));
    g1.appendChild(paramTextRow('Title', 'title.text', 'Lineage flow'));
    g1.appendChild(help('Write {paths}, {nodes} or {flow} (the levels joined by →) for this chart’s numbers, and <Parameter name> for a parameter’s value.'));
    g1.appendChild(segRow('Alignment', 'title.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(checkboxRow('Keep space when empty', 'explanation.reserveSpace'));
    g2.appendChild(paramTextRow('Text', 'explanation.text', '{paths} {flow} paths · click a node to select it'));
    fontRows(g2, 'explanation', true);
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(numberRow('Space above chart', 'card.gap', 0, 60, 1));

    var g2 = group(p, 'Background');
    g2.appendChild(colorRow('Color', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(help('0% is fully transparent. Set worksheet and container shading to None in Tableau to see through.'));

    var g3 = group(p, 'Chart area background');
    g3.appendChild(colorRow('Color', 'card.plotBg'));
    g3.appendChild(rangeRow('Opacity', 'card.plotBgOpacity', 0, 100, 1, '%'));
    g3.appendChild(help('Also used behind the column headers while scrolling.'));
  }

  // ---------------------------------------------------------------------------
  // Presets tab: export / import the chart's settings (file, clipboard, or
  // "My presets" kept in this browser)
  // ---------------------------------------------------------------------------
  var PRESET_TYPE = 'tableau-data-lineage-preset';
  var PRESET_STORE = 'datalineage:presets:v1';

  /**
   * Preset format version. Presets keep only the settings that differ from the
   * defaults, so new options and changed defaults reach old presets on their
   * own. When a setting is renamed or moved, bump this and add a step to
   * PRESET_MIGRATIONS so older preset files keep working.
   *   1 → first format (2026-10-28)
   */
  var PRESET_VERSION = 1;
  var PRESET_MIGRATIONS = {};

  function migratePreset (pr) {
    var v = Number(pr.version) || 1;
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Data Lineage. Update the extension, then import it again.');
    pr = Dl.clone(pr);
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  /**
   * Settings tied to this worksheet's fields (column headers, legend names,
   * where each detail goes, title text). "Look only" presets leave them out,
   * and an import keeps the chart's own unless asked otherwise.
   */
  var FIELD_PATHS = ['names', 'details', 'title.text', 'explanation.text', 'data.countNoun'];

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  function getAt (o, path) { return path.split('.').reduce(function (x, k) { return x == null ? undefined : x[k]; }, o); }

  function setAt (o, path, v) {
    var keys = path.split('.');
    var last = keys.pop();
    var t = keys.reduce(function (x, k) { if (x[k] == null || typeof x[k] !== 'object') x[k] = {}; return x[k]; }, o);
    if (v === undefined) delete t[last]; else t[last] = v;
  }

  function delAt (o, path) { setAt(o, path, undefined); }

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Dl.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Dl.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Dl.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (p) { delAt(s, p); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'Data lineage preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Dl.DEFAULTS) || {}
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Data Lineage preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.dataLineage1) { try { o = typeof o.dataLineage1 === 'string' ? JSON.parse(o.dataLineage1) : o.dataLineage1; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Dl.DEFAULTS; });
    if (!known.length) throw new Error('No Data Lineage settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    var next = Dl.readFrom(pr.settings);
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(pr.settings, p) !== undefined;
      if (keepFields || pr.scope === 'look' || !has) setAt(next, p, Dl.clone(getAt(cfg, p)));
    });
    cfg = next;
    changed();
  }

  function loadStore () {
    try { var a = JSON.parse(localStorage.getItem(PRESET_STORE) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  function saveStore (list) {
    try { localStorage.setItem(PRESET_STORE, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  function fileName (name) {
    return (String(name || 'data-lineage-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'data-lineage-preset') + '.json';
  }

  function download (text, name) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      var a = h('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  function copyText (text, ta) {
    var fallback = function () {
      try { ta.focus(); ta.select(); return document.execCommand('copy'); } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    }
    return Promise.resolve(fallback());
  }

  function presetMsg (g) {
    // kept for a few seconds: the tab is rebuilt when the chart reports back after an import
    if (!presetUi.msg || Date.now() - presetUi.msg.t > 8000) { presetUi.msg = null; return; }
    g.appendChild(h('p', { className: 'preset-msg' + (presetUi.msg.error ? ' is-error' : ''), textContent: presetUi.msg.text }));
  }

  function say (text, error) { presetUi.msg = { text: text, error: !!error, t: Date.now() }; rebuild(); }

  function describe (pr) {
    var d = pr.exported ? new Date(pr.exported) : null;
    return (pr.scope === 'look' ? 'Look only' : 'Everything') + (d && !isNaN(d) ? ' · ' + d.toLocaleDateString() : '');
  }

  function buildPresetsTab (p) {
    presetMsg(p);
    // ---- Export
    var g1 = group(p, 'Export');
    g1.appendChild(help('Saves this chart’s settings as a preset you can import into another Data Lineage, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Bank lineage' });
    name.addEventListener('input', function () { presetUi.name = name.value; });
    rName.appendChild(name);
    g1.appendChild(rName);
    var rScope = row('Include');
    var seg = h('div', { className: 'seg' });
    [['look', 'Look only'], ['all', 'Everything']].forEach(function (o) {
      var b = h('button', { type: 'button', textContent: o[1] });
      b.setAttribute('aria-pressed', String(presetUi.scope === o[0]));
      b.addEventListener('click', function () { presetUi.scope = o[0]; rebuild(); });
      seg.appendChild(b);
    });
    rScope.appendChild(seg);
    g1.appendChild(rScope);
    g1.appendChild(help(presetUi.scope === 'look'
      ? 'Level colours, nodes, links, highlight, headers, legend, search, card… Leaves out what belongs to these fields: column headers, legend names, where each detail goes, title and explanation text.'
      : 'Every setting, including column headers, legend names, where each detail goes and the title and explanation text. Best for a copy of the same sheet.'));

    var ta = h('textarea', { className: 'preset-json', readOnly: true, spellcheck: false });
    var current = function () { return JSON.stringify(makePreset(presetUi.scope, presetUi.name.trim()), null, 2); };
    var btns = h('div', { className: 'inline preset-btns' });
    var bDl = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Download .json' });
    var bCp = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Copy' });
    var bSave = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Save to My presets' });
    var bShow = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Show JSON' });
    bDl.addEventListener('click', function () {
      var t = current();
      ta.value = t;
      say(download(t, fileName(presetUi.name)) ? 'Downloaded ' + fileName(presetUi.name) + '. If nothing appeared (Tableau Desktop can block downloads), use Copy and paste it into a text file.' : 'Download isn’t available here. Use Copy instead.', false);
    });
    bCp.addEventListener('click', function () {
      var t = current();
      ta.value = t; ta.hidden = false;
      copyText(t, ta).then(function (ok) { say(ok ? 'Copied. Paste it into a .json or text file, an email or chat.' : 'Couldn’t copy. Select the text below and copy it yourself.', !ok); });
    });
    bSave.addEventListener('click', function () {
      var nm = presetUi.name.trim() || 'Preset ' + (loadStore().length + 1);
      var list = loadStore().filter(function (x) { return x.name !== nm; });
      var pr = makePreset(presetUi.scope, nm);
      list.unshift(pr);
      say(saveStore(list) ? 'Saved “' + nm + '” to My presets.' : 'Couldn’t save in this browser. Download or copy the preset instead.', false);
    });
    bShow.addEventListener('click', function () { ta.value = current(); ta.hidden = !ta.hidden; });
    btns.append(bDl, bCp, bSave, bShow);
    g1.appendChild(btns);
    ta.hidden = true;
    g1.appendChild(ta);

    // ---- Import
    var g2 = group(p, 'Import');
    g2.appendChild(help('Applies a preset to this chart. Cancel at the bottom undoes it.'));
    g2.appendChild((function () {
      var r = row('Keep this chart’s');
      var input = h('input', { type: 'checkbox' });
      input.checked = presetUi.keepFields;
      input.addEventListener('change', function () { presetUi.keepFields = input.checked; });
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'column headers, legend names, detail placement, title text' })]));
      return r;
    })());
    var file = h('input', { type: 'file', accept: '.json,application/json,text/plain' });
    file.style.display = 'none';
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var pr = parsePreset(rd.result);
          applyImported(pr, presetUi.keepFields);
          say('Applied “' + (pr.name || f.name) + '” (' + describe(pr) + ').', false);
        } catch (e) { say(e.message, true); }
      };
      rd.onerror = function () { say('Couldn’t read the file.', true); };
      rd.readAsText(f);
    });
    var paste = h('textarea', { className: 'preset-json', spellcheck: false, placeholder: 'Or paste a preset here' });
    paste.value = presetUi.pasted;
    paste.addEventListener('input', function () { presetUi.pasted = paste.value; });
    var ib = h('div', { className: 'inline preset-btns' });
    var bFile = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Choose file…' });
    bFile.addEventListener('click', function () { file.value = ''; file.click(); });
    var bPaste = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Apply pasted' });
    bPaste.addEventListener('click', function () {
      if (!paste.value.trim()) { say('Paste a preset into the box first.', true); return; }
      try {
        var pr = parsePreset(paste.value);
        applyImported(pr, presetUi.keepFields);
        presetUi.pasted = '';
        say('Applied “' + pr.name + '” (' + describe(pr) + ').', false);
      } catch (e) { say(e.message, true); }
    });
    ib.append(bFile, bPaste, file);
    g2.appendChild(ib);
    g2.appendChild(paste);

    // ---- My presets (this browser)
    var g3 = group(p, 'My presets');
    var list = loadStore();
    if (!list.length) {
      g3.appendChild(h('p', { className: 'note', textContent: 'None yet. “Save to My presets” keeps a preset on this computer for this extension, ready for any workbook. Download or copy a preset to share it or move it to another computer.' }));
    } else {
      g3.appendChild(help('Kept on this computer for this extension (any workbook). Clearing the browser data of Tableau removes them, so download the ones you want to keep.'));
      list.forEach(function (pr, i) {
        var r = h('div', { className: 'preset-item' });
        var t = h('div', { className: 'preset-name' }, [h('b', { textContent: pr.name }), h('span', { className: 'help', textContent: ' ' + describe(pr) })]);
        var apply = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Apply' });
        apply.addEventListener('click', function () { applyImported(pr, presetUi.keepFields); say('Applied “' + pr.name + '”.', false); });
        var dl = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Download' });
        dl.addEventListener('click', function () { download(JSON.stringify(pr, null, 2), fileName(pr.name)); });
        var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Delete', title: 'Delete this preset' });
        del.addEventListener('click', function () {
          if (del.dataset.sure) { var l = loadStore(); l.splice(i, 1); saveStore(l); say('Deleted “' + pr.name + '”.', false); return; }
          del.dataset.sure = '1'; del.textContent = 'Sure?';
          setTimeout(function () { delete del.dataset.sure; del.textContent = 'Delete'; }, 2500);
        });
        r.append(t, h('div', { className: 'inline' }, [apply, dl, del]));
        g3.appendChild(r);
      });
    }
  }


  // ---------------------------------------------------------------------------
  // Parameters in texts, and names of the Measure / Line / Target / Tooltip fields
  // ---------------------------------------------------------------------------
  function paramVal (name) {
    var k = String(name || '').trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase();
    var p = (info.params || []).find(function (x) { return String(x.name).toLowerCase() === k; });
    return p ? p.value : null;
  }

  function fillTokens (text) {
    return String(text || '').replace(/<([^<>]+)>/g, function (all, nm) { var v = paramVal(nm); return v != null ? v : all; });
  }

  /** Text setting that can hold <Parameter> tokens: an "Insert parameter" list and a preview. */
  function paramTextRow (label, path, placeholder, onChange) {
    var wrap = h('div');
    var r = row(label);
    var cur = get(path);
    var input = h('input', { type: 'text', value: cur == null ? '' : cur, placeholder: placeholder || '' });
    r.appendChild(input);
    wrap.appendChild(r);
    var tools = h('div', { className: 'row' });
    tools.appendChild(h('span'));
    var line = h('div', { className: 'inline param-tools' });
    var prev = h('span', { className: 'help param-preview' });
    var upd = function () {
      var t = input.value;
      var has = /<[^<>]+>/.test(t);
      prev.textContent = has ? 'Shows: ' + fillTokens(t) : '';
      var unknown = (t.match(/<([^<>]+)>/g) || []).filter(function (x) { return paramVal(x.slice(1, -1)) == null; });
      prev.classList.toggle('is-warn', unknown.length > 0);
      if (unknown.length) prev.textContent += '  (no parameter named ' + unknown.join(', ') + ')';
    };
    input.addEventListener('input', function () { set(path, input.value); upd(); if (onChange) onChange(); });
    if ((info.params || []).length) {
      var sel = h('select', { className: 'param-insert' });
      sel.appendChild(h('option', { value: '', textContent: 'Insert parameter…' }));
      info.params.forEach(function (p) { sel.appendChild(h('option', { value: p.name, textContent: p.name + '  (' + p.value + ')' })); });
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        var tok = '<' + sel.value + '>';
        var a = input.selectionStart != null ? input.selectionStart : input.value.length;
        var b = input.selectionEnd != null ? input.selectionEnd : a;
        input.value = input.value.slice(0, a) + tok + input.value.slice(b);
        sel.value = '';
        set(path, input.value); upd(); if (onChange) onChange();
        input.focus();
        input.setSelectionRange(a + tok.length, a + tok.length);
      });
      line.appendChild(sel);
    }
    line.appendChild(prev);
    tools.appendChild(line);
    wrap.appendChild(tools);
    upd();
    return wrap;
  }


  function buildIconTab (p) {
    var ic = cfg.icon;

    var preview = h('div', { className: 'icon-preview' });
    var slot = h('div', { className: 'slot' });
    var name = h('div', { className: 'name' });
    preview.append(slot, name);
    var refreshPreview = function () {
      slot.innerHTML = '';
      slot.classList.remove('slot--dark');
      if (!ic.show) { name.textContent = 'Icon hidden'; return; }
      if (ic.source === 'builtin') {
        var r = Dl.iconHtml(ic.builtinId, ic.color);
        slot.innerHTML = r.html;
        slot.classList.toggle('slot--dark', !!r.icon.light);
        name.textContent = r.icon.label;
      } else if (ic.mask && ic.dataUrl) {
        var t = 24; var iw = ic.w || 1; var ih = ic.h || 1;
        var W = iw >= ih ? t : Math.round(t * iw / ih); var H = iw >= ih ? Math.round(t * ih / iw) : t;
        var mk = 'url(' + ic.dataUrl + ') center / contain no-repeat';
        slot.innerHTML = '<span style="display:block;width:' + W + 'px;height:' + H + 'px;background-color:' + ic.color + ';-webkit-mask:' + mk + ';mask:' + mk + '"></span>';
        name.textContent = ic.name || 'Uploaded image';
      } else if (ic.dataUrl) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 24; var hh = img.naturalHeight || 24;
          if (w >= hh) { img.style.width = '24px'; img.style.height = 'auto'; } else { img.style.height = '24px'; img.style.width = 'auto'; }
        };
        img.src = ic.dataUrl;
        slot.appendChild(img);
        name.textContent = ic.name || (ic.source === 'shape' ? 'Tableau shape' : 'Uploaded image');
      } else {
        name.textContent = 'No image chosen yet';
      }
    };
    refreshPreview();

    var g = group(p, 'Icon');
    g.appendChild(preview);
    g.appendChild(checkboxRow('Show icon', 'icon.show', function () { refreshPreview(); }));
    g.appendChild(rangeRow('Size', 'icon.size', 12, 96, 1, ' px'));
    g.appendChild(h('div', { className: 'help', textContent: 'Length of the icon\u2019s longer side. Figma default is 24 px; icons stay sharpest up to about 48 px.' }));

    if (ic.source === 'shape') ic.source = 'upload'; // Tableau shapes were removed: a picked shape is kept as an image
    var sources = [['builtin', 'Built-in'], ['upload', 'Upload']];
    var sourceRow = row('Source');
    var seg = h('div', { className: 'seg' });
    sources.forEach(function (s) {
      var b = h('button', { type: 'button', textContent: s[1] });
      b.setAttribute('aria-pressed', String(ic.source === s[0]));
      b.addEventListener('click', function () {
        ic.source = s[0];
        if (s[0] === 'builtin') ic.show = true;
        changed();
        buildTabs();
      });
      seg.appendChild(b);
    });
    sourceRow.appendChild(seg);
    g.appendChild(sourceRow);

    var body = group(p, sources.find(function (s) { return s[0] === ic.source; })[1]);

    if (ic.source === 'builtin') {
      var gridWrap = h('div');
      var fillGrid = function () {
        gridWrap.innerHTML = '';
        Dl.ICON_GROUPS.forEach(function (groupName) {
          var icons = Dl.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Dl.iconHtml(icon.id, ic.color).html;
            if (icon.id === ic.builtinId) cell.classList.add('is-active');
            cell.addEventListener('click', function () {
              ic.builtinId = icon.id;
              ic.show = true;
              Array.prototype.forEach.call(gridWrap.querySelectorAll('.cell'), function (c) { c.classList.remove('is-active'); });
              cell.classList.add('is-active');
              changed();
              refreshPreview();
            });
            grid.appendChild(cell);
          });
          gridWrap.appendChild(grid);
        });
      };
      body.appendChild(colorRow('Icon color', 'icon.color', function () { refreshPreview(); fillGrid(); }));
      body.appendChild(h('div', { className: 'help', textContent: 'Recolours the built-in icons.' }));
      fillGrid();
      body.appendChild(gridWrap);
    } else {
      body.appendChild(colorRow('Icon color', 'icon.color', function () { refreshPreview(); }));
      body.appendChild(help(ic.dataUrl && !ic.mask ? 'This image keeps its own colours (added before uploads became one-colour shapes). Upload it again to recolour it.' : 'Uploads become one-colour shapes like the built-ins, so Size and Icon color apply.'));
      buildUpload(body, refreshPreview);
    }
  }

  function buildUpload (body, refreshPreview) {
    var drop = h('label', { className: 'drop' });
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,.ico' });
    drop.append(input,
      h('b', { textContent: 'Choose an image' }),
      h('span', { textContent: 'or drop it here — PNG, SVG, JPG, GIF. Tableau custom shapes work too.' }));
    body.appendChild(drop);
    body.appendChild(h('p', {
      className: 'note',
      textContent: 'The image becomes a one-colour shape (its transparent or light background is dropped), stored at 96 px.'
    }));

    var take = function (file) {
      if (!file) return;
      blobToMask(file).then(function (m) {
        cfg.icon.source = 'upload';
        cfg.icon.dataUrl = m.url;
        cfg.icon.mask = true;
        cfg.icon.w = m.w;
        cfg.icon.h = m.h;
        cfg.icon.name = file.name;
        cfg.icon.show = true;
        changed();
        refreshPreview();
      }).catch(function (e) { setStatus('Could not read that image: ' + e.message); });
    };
    input.addEventListener('change', function () { take(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) { take(e.dataTransfer.files[0]); });
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function fontRows (g, section, withItalic) {
    g.appendChild(fontFamilyRow('Font', P(section, 'font')));
    g.appendChild(numberRow('Size (px)', P(section, 'size'), 6, 160, 1));
    g.appendChild(selectRow('Weight', P(section, 'weight'), WEIGHTS));
    g.appendChild(colorRow('Color', P(section, 'color')));
    if (withItalic !== false) g.appendChild(checkboxRow('Italic', P(section, 'italic')));
  }

  function fontFamilyRow (label, path) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var sel = h('select');
    Dl.FONTS.forEach(function (f) { sel.appendChild(h('option', { value: f, textContent: f })); });
    sel.appendChild(h('option', { value: '__custom', textContent: 'Other…' }));
    var custom = h('input', { type: 'text', placeholder: 'Installed font name' });
    var current = get(path);
    if (Dl.FONTS.indexOf(current) >= 0) { sel.value = current; custom.hidden = true; } else { sel.value = '__custom'; custom.value = current; }
    sel.addEventListener('change', function () {
      custom.hidden = sel.value !== '__custom';
      if (sel.value !== '__custom') { set(path, sel.value); } else { custom.focus(); }
    });
    custom.addEventListener('input', function () { if (custom.value.trim()) set(path, custom.value.trim()); });
    wrap.append(sel, custom);
    r.appendChild(wrap);
    return r;
  }

  function textRow (label, path, placeholder) {
    var r = row(label);
    var cur = get(path);
    var input = h('input', { type: 'text', value: cur == null ? '' : cur, placeholder: placeholder || '' });
    input.addEventListener('input', function () { set(path, input.value); });
    r.appendChild(input);
    return r;
  }

  function numberRow (label, path, min, max, step) {
    var r = row(label);
    var input = h('input', { type: 'number', min: min, max: max, step: step, value: get(path) });
    input.addEventListener('input', function () {
      var n = Number(input.value);
      if (input.value === '' || !isFinite(n)) return;
      set(path, Math.max(min, Math.min(max, n)));
    });
    r.appendChild(input);
    return r;
  }

  function rangeRow (label, path, min, max, step, unit) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var input = h('input', { type: 'range', min: min, max: max, step: step, value: get(path) });
    var out = h('span', { className: 'readout', textContent: get(path) + (unit || '') });
    input.addEventListener('input', function () { set(path, Number(input.value)); out.textContent = input.value + (unit || ''); });
    wrap.append(input, out);
    r.appendChild(wrap);
    return r;
  }

  function selectRow (label, path, options, help, after) {
    var r = row(label);
    var sel = h('select');
    options.forEach(function (o) { sel.appendChild(h('option', { value: String(o[0]), textContent: o[1] })); });
    sel.value = String(get(path));
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    sel.addEventListener('change', function () {
      var orig = options.find(function (o) { return String(o[0]) === sel.value; })[0];
      set(path, orig);
      if (after) after();
    });
    r.appendChild(sel);
    if (help) { var frag = document.createDocumentFragment(); frag.append(r, h('div', { className: 'help', textContent: help })); return wrapRows(frag); }
    return r;
  }

  function segRow (label, path, options, after) {
    var r = row(label);
    var seg = h('div', { className: 'seg' });
    options.forEach(function (o) {
      var b = h('button', { type: 'button', textContent: o[1] });
      b.setAttribute('aria-pressed', String(get(path) === o[0]));
      b.addEventListener('click', function () {
        set(path, o[0]);
        Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        if (after) after();
      });
      seg.appendChild(b);
    });
    r.appendChild(seg);
    return r;
  }

  function checkboxRow (label, path, after) {
    var r = row(label);
    var input = h('input', { type: 'checkbox' });
    input.checked = !!get(path);
    input.addEventListener('change', function () { set(path, input.checked); if (after) after(); });
    r.appendChild(h('div', { className: 'inline' }, [input]));
    return r;
  }

  function colorRow (label, path, after) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var picker = h('input', { type: 'color', value: Dl.normalizeHex(get(path)) || '#000000' });
    var hex = h('input', { type: 'text', className: 'hex', value: get(path), maxLength: 7, spellcheck: false });
    picker.addEventListener('input', function () {
      hex.value = picker.value.toUpperCase(); hex.classList.remove('is-invalid');
      set(path, hex.value); if (after) after();
    });
    hex.addEventListener('input', function () {
      var v = Dl.normalizeHex(hex.value);
      hex.classList.toggle('is-invalid', !v);
      if (v) { picker.value = v; set(path, v); if (after) after(); }
    });
    hex.addEventListener('blur', function () { hex.value = get(path); hex.classList.remove('is-invalid'); });
    wrap.append(picker, hex);
    r.appendChild(wrap);
    return r;
  }

  function wrapRows (frag) { var d = h('div'); d.appendChild(frag); return d; }

  function row (label) {
    var r = h('div', { className: 'row' });
    r.appendChild(h('label', { textContent: label }));
    return r;
  }

  function group (parent, title) {
    var g = h('div', { className: 'group' });
    g.appendChild(h('h3', { className: 'group-title', textContent: title }));
    parent.appendChild(g);
    return g;
  }

  function h (tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'role') n.setAttribute('role', props[k]); else n[k] = props[k];
    });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  // ---------------------------------------------------------------------------
  // Images
  // ---------------------------------------------------------------------------

  /**
   * Turns an image into a one-colour shape like the built-in icons: a 96 px PNG
   * whose alpha is the shape. Transparent images keep their alpha; opaque ones
   * (JPG, logos on white) use darkness against a light background, or lightness
   * against a dark one.
   */
  function blobToMask (blob) {
    return readAsDataUrl(blob).then(function (url) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 96; var hh = img.naturalHeight || 96;
          var k = 96 / Math.max(w, hh);
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hh * k));
          var ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, c.width, c.height);
          var d = ctx.getImageData(0, 0, c.width, c.height);
          var px = d.data;
          var n = px.length / 4;
          var see = 0;
          for (var i = 0; i < n; i++) if (px[i * 4 + 3] < 250) see++;
          var useAlpha = see > n * 0.02;
          // background brightness from the border
          var lumAt = function (j) { return (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) / 255; };
          var bsum = 0; var bn = 0;
          for (var x = 0; x < c.width; x++) { bsum += lumAt(x * 4) + lumAt(((c.height - 1) * c.width + x) * 4); bn += 2; }
          var lightBg = bsum / bn >= 0.5;
          for (var p2 = 0; p2 < n; p2++) {
            var o = p2 * 4;
            var a = px[o + 3] / 255;
            if (!useAlpha) { var l = lumAt(o); a = lightBg ? 1 - l : l; a = Math.max(0, Math.min(1, (a - 0.06) / 0.88)); }
            px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = Math.round(a * 255);
          }
          ctx.putImageData(d, 0, 0);
          resolve({ url: c.toDataURL('image/png'), w: c.width, h: c.height });
        };
        img.onerror = function () { reject(new Error('unsupported image format')); };
        img.src = url;
      });
    });
  }

  function readAsDataUrl (blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  function get (path) {
    return P(path).reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg);
  }

  function set (path, value) {
    var keys = P(path);
    var last = keys.pop();
    keys.reduce(function (o, k) {
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, cfg)[last] = value;
    changed();
  }

  /**
   * A change is shown in the chart at once through the live-preview channel
   * (localStorage, see the chart's onLiveSettings), and saved to the workbook a
   * moment later. Saves never overlap: a change during a save is saved after it.
   */
  var liveTimer = null;
  function changed () {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(pushLive, 16);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 450);
  }

  function pushLive () {
    if (!info.liveId) return;
    try { window.localStorage.setItem('datalineage:live:' + info.liveId, JSON.stringify({ t: Date.now(), cfg: cfg })); } catch (e) { /* preview only */ }
  }

  function flush () {
    clearTimeout(saveTimer);
    clearTimeout(liveTimer);
    pushLive();
    return persist();
  }

  var saving = null;
  var saveAgain = false;
  function persist () {
    if (saving) { saveAgain = true; return saving; }
    try {
      setStatus('Saving…');
      saving = Dl.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); })
        .then(function () {
          saving = null;
          if (saveAgain) { saveAgain = false; return persist(); }
        });
      return saving;
    } catch (err) {
      console.error(err);
      saving = null;
      return Promise.resolve();
    }
  }

  /** The chart sends back what the dialog lists (fields, legend items …) after each change. */
  function onChartInfo (e) {
    if (!info.liveId || e.key !== 'datalineage:info:' + info.liveId || !e.newValue) return;
    var p;
    try { p = JSON.parse(e.newValue); } catch (err) { return; }
    var before = JSON.stringify(info);
    Object.keys(info).forEach(function (k) { if (k !== 'focus' && k !== 'liveId' && p[k] != null) info[k] = p[k]; });
    if (JSON.stringify(info) === before) return;
    var a = document.activeElement;
    var typing = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /text|number|search/.test(a.type)));
    if (!typing) rebuild();
  }

  function setStatus (text) {
    document.getElementById('status').textContent = text;
  }

  function cleanupLive () {
    try {
      window.localStorage.removeItem('datalineage:live:' + info.liveId);
      window.localStorage.removeItem('datalineage:info:' + info.liveId);
    } catch (e) { /* ignore */ }
  }

  function close () {
    cleanupLive();
    tableau.extensions.ui.closeDialog(' ');
  }

  window.DataLineageConfigure = { init: init };
})();
