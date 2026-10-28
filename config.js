'use strict';

/**
 * Data Lineage — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, colours and the
 * built-in icon set (the same set as KPI Card, Waterfall and Bar Chart).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  var STORAGE_KEY = 'dataLineage1';

  var FONT_STACK_FALLBACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  var MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

  /** Font families offered in the dialog. "Lato" ships with the extension. */
  var FONTS = [
    'Lato',
    'IBM Plex Sans',
    'Tableau Book',
    'Tableau Medium',
    'Tableau Semibold',
    'Tableau Bold',
    'Benton Sans',
    'Arial',
    'Helvetica Neue',
    'Segoe UI',
    'Roboto',
    'Open Sans',
    'Georgia',
    'Times New Roman',
    'Courier New'
  ];

  /** Level colours, by position on the Levels tile (from the design: table, data source, workbook, view). */
  var LEVEL_COLORS = ['#4A5468', '#0F7C7C', '#7B4FD1', '#C2426B', '#E08A2E', '#2F7FC1'];

  /** Look of one level (column), by position. Field-specific texts live in `names`. */
  var LEVEL = {
    color: '#4A5468',
    mono: false, // node names in a monospace font (table names in the design)
    count: false, // "· 9 views": how many last-level items the node feeds
    subPos: 'below' // subtitle above or below the name
  };

  var DEFAULTS = {
    // ---- Header + card (Icon and Title & text = KPI Card; Card = Waterfall) --
    icon: {
      show: false,
      source: 'builtin', // builtin | upload
      builtinId: 'fg-bar-chart-solid',
      size: 24,
      color: '#EB644C',
      dataUrl: '',
      name: '',
      mask: false,
      w: 0,
      h: 0
    },
    title: {
      show: true,
      text: 'Lineage flow', // {paths} {nodes} {flow} and <Parameter> work here
      align: 'left',
      font: 'Lato',
      size: 16,
      weight: 700,
      color: '#17202B',
      italic: false
    },
    explanation: {
      show: true,
      reserveSpace: false,
      text: '{paths} {flow} paths · click a node to select it',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: false
    },
    card: {
      padding: 15,
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      gap: 12, // space between the header and the chart
      plotBg: '#FFFFFF',
      plotBgOpacity: 0
    },

    // ---- Levels ------------------------------------------------------------
    levels: [
      { color: LEVEL_COLORS[0], mono: true, count: true, subPos: 'above' },
      { color: LEVEL_COLORS[1], mono: false, count: false, subPos: 'below' },
      { color: LEVEL_COLORS[2], mono: false, count: false, subPos: 'below' },
      { color: LEVEL_COLORS[3], mono: false, count: false, subPos: 'below' },
      { color: LEVEL_COLORS[4], mono: false, count: false, subPos: 'below' },
      { color: LEVEL_COLORS[5], mono: false, count: false, subPos: 'below' }
    ],
    names: {}, // level field name → { header, legend } (empty → the field name)
    details: {}, // detail field name → { level: 'auto' | 0…5, show: 'subtitle' | 'inline' | 'tooltip' | 'hidden' }
    data: {
      nulls: 'skip', // skip (the path jumps over the empty level) | show ("Null" node)
      sort: 'flow', // flow (fewest crossings) | name | paths (most paths first)
      countNoun: '' // "9 views": empty → the last level's name
    },

    // ---- Column headers ----------------------------------------------------
    headers: {
      show: true,
      font: 'Lato',
      size: 11,
      weight: 700,
      color: '#68707D',
      uppercase: true,
      spacing: 0.06 // letter spacing (em)
    },

    // ---- Nodes ---------------------------------------------------------------
    nodes: {
      align: 'flow', // flow (next to the nodes they link to) | top (each column from the top)
      minWidth: 140,
      maxWidth: 240,
      gap: 10, // vertical space between nodes
      padX: 10,
      padY: 6,
      radius: 4,
      bg: '#FFFFFF',
      border: '#D5D9DF',
      borderWidth: 1,
      marker: 'square', // square | circle | none
      markerSize: 8,
      maxLines: 2,
      font: 'Lato',
      size: 12,
      weight: 600,
      color: '#17202B',
      subFont: 'Lato',
      subSize: 11,
      subWeight: 400,
      subColor: '#68707D'
    },

    // ---- Links ---------------------------------------------------------------
    links: {
      curve: 'bezier', // bezier | step | straight
      color: '#D5D9DF',
      width: 1.2,
      opacity: 100,
      minSpace: 48 // smallest gap between columns, for the links
    },

    // ---- Selection / highlight ------------------------------------------------
    highlight: {
      color: '#2F5BD3', // links of the selected lineage
      width: 2,
      nodeBg: '#EEF3FD',
      nodeBorder: '#2F5BD3',
      boldTitle: true,
      fade: 'none', // none | fade | hide: what happens to nodes outside the lineage
      fadeOpacity: 35,
      hover: true, // preview a node's lineage while hovering
      matchColor: '#EB644C' // outline of nodes matching the search
    },

    // ---- Legend ------------------------------------------------------------------
    legend: {
      show: true,
      position: 'header', // header (right of the title) | top | bottom
      useHeaders: false, // legend names: false = the field names, true = the column headers
      showSelected: true,
      selectedText: 'Selected Node',
      font: 'Lato',
      size: 12,
      color: '#3D4552'
    },

    // ---- Search ------------------------------------------------------------------
    search: {
      show: true,
      placeholder: 'Search nodes…',
      mode: 'highlight', // highlight (matches + their lineage) | filter (hide the rest)
      width: 180
    },

    // ---- Expand / collapse ---------------------------------------------------------
    collapse: {
      button: true, // +/− button on the right of every node that has relations in the next column
      startCollapsed: false // true: only the first column shows; expand nodes one by one
    },

    // ---- Tooltip + interaction ---------------------------------------------------
    tooltip: {
      show: true,
      showDetails: true,
      showCounts: true // "Feeds 2 data sources · 4 views"
    },
    interaction: {
      rightClickMenu: true,
      dblclick: 'format', // format | none
      dialog: 'onTop', // onTop (modal: stays in front of Tableau) | floating (modeless)
      selectInTableau: true // click a node: its value is selected in Tableau (dashboard actions)
    }
  };

  // -------------------------------------------------------------------------
  // Built-in icons: only the Figma "Icons for Extension" set (icons.js).
  // -------------------------------------------------------------------------
  var ICONS = (window.KPI3_FIGMA_ICONS || []).map(function (ic) {
    var o = {}; for (var k in ic) o[k] = ic[k]; o.figma = true; return o;
  });

  var ICON_GROUPS = ['Chart icons', 'Others'];

  function findIcon (id) {
    var fallback = ICONS[0];
    for (var i = 0; i < ICONS.length; i++) {
      if (ICONS[i].id === id) return ICONS[i];
      if (ICONS[i].id === DEFAULTS.icon.builtinId) fallback = ICONS[i];
    }
    return fallback;
  }

  function iconSize (icon, target) {
    var t = Number(target) > 0 ? Number(target) : 24;
    var w = icon.w || 24;
    var h = icon.h || 24;
    return w >= h
      ? { w: t, h: Math.max(1, Math.round(t * h / w)) }
      : { w: Math.max(1, Math.round(t * w / h)), h: t };
  }

  function iconHtml (id, color, target) {
    var icon = findIcon(id);
    if (!icon) return { html: '', w: 0, h: 0, icon: { label: '' } };
    var size = iconSize(icon, target);
    var html;
    if (icon.src) {
      if (icon.tint) {
        var m = 'url(' + icon.src + ') center / contain no-repeat';
        html = '<span class="kpi3-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
          'px;background-color:' + color + ';-webkit-mask:' + m + ';mask:' + m + '"></span>';
      } else {
        html = '<img src="' + icon.src + '" alt="" width="' + size.w + '" height="' + size.h +
          '" style="display:block;width:' + size.w + 'px;height:' + size.h + 'px">';
      }
    } else {
      var paint = icon.mode === 'stroke'
        ? 'fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="' + color + '"';
      html = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.w + '" height="' + size.h + '" viewBox="0 0 24 24" style="display:block">' +
        '<path ' + paint + ' d="' + icon.d + '"/></svg>';
    }
    return { html: html, w: size.w, h: size.h, icon: icon };
  }

  // -------------------------------------------------------------------------
  // Settings I/O
  // -------------------------------------------------------------------------
  function clone (o) { return JSON.parse(JSON.stringify(o)); }

  function isMap (o) { return o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length; }

  /**
   * Deep-merges stored values over the defaults so new keys get defaults.
   * An empty object in the defaults ({}) is a map: the stored map is copied as
   * is. Arrays are copied as stored, except `levels`, whose items are merged
   * over LEVEL one by one.
   */
  function merge (base, over) {
    var out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(out).forEach(function (k) {
      if (!(k in over)) return;
      if (isMap(out[k])) {
        if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = clone(over[k]);
      } else if (Array.isArray(out[k])) {
        if (Array.isArray(over[k])) out[k] = clone(over[k]);
      } else if (out[k] && typeof out[k] === 'object') {
        out[k] = merge(out[k], over[k]);
      } else if (typeof over[k] === typeof out[k] || out[k] === '' || out[k] == null) {
        out[k] = over[k];
      }
    });
    return out;
  }

  /** Stored settings over the defaults; every level filled in. */
  function normalize (cfg) {
    var lv = [];
    for (var i = 0; i < 6; i++) {
      var d = DEFAULTS.levels[i];
      lv.push(merge(merge(LEVEL, d), (cfg.levels || [])[i]));
    }
    cfg.levels = lv;
    return cfg;
  }

  function readFrom (obj) { return normalize(merge(DEFAULTS, obj)); }

  function read () {
    try {
      var raw = tableau.extensions.settings.get(STORAGE_KEY);
      return readFrom(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return normalize(clone(DEFAULTS));
    }
  }

  function write (cfg) {
    tableau.extensions.settings.set(STORAGE_KEY, JSON.stringify(cfg));
    return tableau.extensions.settings.saveAsync();
  }

  function levelCfg (cfg, i) { return cfg.levels[i] || merge(LEVEL, { color: LEVEL_COLORS[i % LEVEL_COLORS.length] }); }

  // -------------------------------------------------------------------------
  // Fonts + colours
  // -------------------------------------------------------------------------
  function fontStack (family) {
    if (!family) return FONT_STACK_FALLBACK;
    return '"' + String(family).replace(/"/g, '') + '", ' + FONT_STACK_FALLBACK;
  }

  function normalizeHex (value) {
    if (typeof value !== 'string') return null;
    var hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/(.)/g, '$1$1');
    return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null;
  }

  function rgb (hex) {
    var h = normalizeHex(hex) || '#000000';
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function toHex (c) {
    return '#' + c.map(function (x) { return ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2); }).join('').toUpperCase();
  }

  function rgba (hex, alpha) {
    var c = rgb(hex);
    return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + alpha + ')';
  }

  /** Mixes two colours: t = 0 → a, t = 1 → b. */
  function mix (a, b, t) {
    var x = rgb(a); var y = rgb(b);
    return toHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; }));
  }

  function tint (hex, t) { return mix(hex, '#FFFFFF', t); }

  window.Dl = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    LEVEL: LEVEL,
    LEVEL_COLORS: LEVEL_COLORS,
    FONTS: FONTS,
    MONO_STACK: MONO_STACK,
    ICONS: ICONS,
    ICON_GROUPS: ICON_GROUPS,
    findIcon: findIcon,
    iconHtml: iconHtml,
    clone: clone,
    merge: merge,
    normalize: normalize,
    readFrom: readFrom,
    read: read,
    write: write,
    levelCfg: levelCfg,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    mix: mix,
    tint: tint
  };
  window.Kpi3 = window.Kpi3 || window.Dl;
})();
