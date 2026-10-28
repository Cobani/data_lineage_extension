'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=lineage | small | gaps | big | one
 * - ?rename: the first Levels pill is "renamed", so the Marks card reports a
 *   different name than the data column, as Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var SET_KEY = 'dlMockSettings';
  var PAYLOAD_KEY = 'dlMockPayload';
  var RENAME = params.has('rename');

  // deterministic pseudo-random numbers
  var seed = 11;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function pick (a) { return a[Math.floor(rnd() * a.length)]; }

  var MOCK_PARAMS = [['Environment', 'Production']].map(function (p) {
    var o = { name: p[0], id: p[0], currentValue: { value: p[1], formattedValue: p[1] }, _h: [] };
    o.addEventListener = function (t, h) { o._h.push(h); };
    return o;
  });

  // ---- the design's lineage (table → data source → workbook → view) ---------
  var DS = {
    'Daily View Data (local copy)': ['Embedded · Extract', 'D360 Metrics (Self-Service) - All Savings Accounts Template', [['All Savings - Daily Cost View', 'dashboard'], ['All Savings - Daily View', 'dashboard']]],
    'Monthly View Data': ['Embedded · Extract', 'D360 Metrics (Self-Service) - All Savings Accounts Template', [['All Savings - Monthly Cost View', 'dashboard'], ['All Savings - Monthly View', 'dashboard']]],
    'daily Savings': ['Embedded · Extract', 'Saving Promocode Campaign', [['Promocode Campaign', 'dashboard']]],
    'Savings Monthly Data': ['Embedded · Extract', 'Savings Accounts Monthly View', [['Savings Accounts Monthly View', 'dashboard']]],
    'Savings Accounts': ['Embedded · Extract', 'Savings Accounts', [['Savings Accounts Overview', 'dashboard']]],
    'all User': ['Extract · Simulator', 'Savings Acc. Cost of Deposit Simulator', [['Simulator', 'dashboard'], ['Sheet 2', 'sheet']]],
    'all User (V2)': ['Extract · Simulator V2', 'Savings Acc. Cost of Deposit Simulator V2', [['Simulator V2', 'dashboard'], ['Sheet 2 (V2)', 'sheet']]],
    'all User (V3)': ['Extract · Simulator V3', 'Savings Acc. Cost of Deposit Simulator V3', [['Simulator V3', 'dashboard'], ['Sheet 2 (V3)', 'sheet']]],
    'Promocode Download': ['Embedded · Live', 'Saving Promocode Campaign', [['Data Download', 'dashboard'], ['promocode (4)', 'sheet']]],
    'Deposits Daily': ['Published · Extract', 'Treasury Deposits', [['Deposit Book', 'dashboard'], ['Rates', 'sheet']]],
    'Customer 360': ['Published · Extract', 'Customer 360', [['Overview', 'dashboard'], ['Segments', 'dashboard'], ['Detail', 'sheet']]],
    'Cards Spend': ['Published · Live', 'Cards Performance', [['Spend by MCC', 'dashboard'], ['Spend Trend', 'sheet']]]
  };
  var OWNERS = { 'Saving Promocode Campaign': 'Marketing BI', 'Treasury Deposits': 'Treasury', 'Customer 360': 'CRM Analytics', 'Cards Performance': 'Cards BI' };

  function dsRows (table, schema, list) {
    var rows = [];
    list.forEach(function (ds) {
      var d = DS[ds];
      d[2].forEach(function (v) {
        rows.push({ Table: table, Schema: schema, 'Data Source': ds, 'DS Type': d[0], Workbook: d[1], View: v[0], 'View Type': v[1] === 'sheet' ? 'sheet' : null, Owner: OWNERS[d[1]] || 'Savings BI' });
      });
    });
    return rows;
  }

  var DATASETS = {
    lineage: function () {
      var rows = [];
      var main = ['Daily View Data (local copy)', 'Monthly View Data', 'daily Savings', 'Savings Monthly Data', 'Savings Accounts', 'all User'];
      rows = rows.concat(dsRows('customer_monthly_savings_metrics', 'enriched', main));
      rows = rows.concat(dsRows('customer_daily_savings_metrics', 'enriched', main));
      rows = rows.concat(dsRows('customer_demographics', 'enriched', ['Daily View Data (local copy)', 'Monthly View Data', 'daily Savings', 'Savings Accounts', 'all User']));
      rows = rows.concat(dsRows('customer', 'enriched', ['Savings Monthly Data', 'Savings Accounts', 'all User']));
      rows = rows.concat(dsRows('tbl_promocode_customer_3_mar', 'public', ['all User (V2)', 'Promocode Download']));
      rows = rows.concat(dsRows('monthly_savings_min_balance_during_month', 'public', ['all User (V3)', 'Promocode Download']));
      var extra = ['deposit_balances_daily', 'deposit_rates', 'fx_rates', 'card_transactions', 'card_accounts', 'mcc_codes', 'customer_segments', 'crm_contacts',
        'murex_sukuk_positions', 'sarie_payments', 'sadad_bills', 'rtgs_transfers', 'moyasar_payments', 'kyc_profiles', 'branch_dim', 'calendar_dim',
        'product_dim', 'gl_balances', 'interest_accruals', 'loan_book', 'ledger_entries'];
      var others = ['Deposits Daily', 'Customer 360', 'Cards Spend'];
      extra.forEach(function (t, i) {
        var n = 1 + Math.floor(rnd() * 2);
        var list = [others[i % 3]];
        if (n > 1) list.push(pick(others.concat(['Savings Accounts'])));
        list = list.filter(function (x, k) { return list.indexOf(x) === k; });
        rows = rows.concat(dsRows(t, pick(['enriched', 'public', 'staging']), list));
      });
      return { tiles: { levels: ['Table', 'Data Source', 'Workbook', 'View'], details: ['Schema', 'DS Type', 'View Type'], tooltip: ['Owner'] }, rows: rows };
    },
    small: function () {
      var rows = [];
      var src = ['core_banking', 'cards_switch', 'crm', 'treasury'];
      var pipes = { core_banking: ['dwh.accounts', 'dwh.transactions'], cards_switch: ['dwh.card_txn'], crm: ['dwh.customers'], treasury: ['dwh.positions'] };
      var reps = { 'dwh.accounts': ['Funding Dashboard', 'Balance Sheet'], 'dwh.transactions': ['Funding Dashboard', 'Money Movement'], 'dwh.card_txn': ['Cards KPI'], 'dwh.customers': ['Customer 360', 'Funding Dashboard'], 'dwh.positions': ['Treasury Book'] };
      src.forEach(function (s) { pipes[s].forEach(function (p) { reps[p].forEach(function (r) { rows.push({ System: s, Model: p, Report: r }); }); }); });
      return { tiles: { levels: ['System', 'Model', 'Report'] }, rows: rows };
    },
    gaps: function () {
      var d = DATASETS.lineage();
      d.rows = d.rows.slice(0, 40);
      d.rows.push({ Table: 'orphan_table_no_usage', Schema: 'staging', 'Data Source': null, 'DS Type': null, Workbook: null, View: null });
      d.rows.push({ Table: 'raw_events', Schema: 'staging', 'Data Source': 'Events (published)', 'DS Type': 'Published · Live', Workbook: null, View: null });
      d.rows.push({ Table: null, Schema: null, 'Data Source': 'Custom SQL – fees', 'DS Type': 'Embedded · Live', Workbook: 'Fees Review', View: 'Fees' });
      return d;
    },
    big: function () {
      var rows = [];
      var n = Number(params.get('n')) || 120;
      for (var t = 0; t < n; t++) {
        var k = 1 + Math.floor(rnd() * 3);
        for (var j = 0; j < k; j++) {
          var ds = 'Data source ' + Math.floor(rnd() * n / 2);
          var wb = 'Workbook ' + Math.floor(rnd() * n / 3);
          var views = 1 + Math.floor(rnd() * 3);
          for (var v = 0; v < views; v++) rows.push({ Table: 'table_' + t, Schema: t % 3 ? 'enriched' : 'public', 'Data Source': ds, Workbook: wb, View: wb + ' – view ' + (v + 1) });
        }
      }
      return { tiles: { levels: ['Table', 'Data Source', 'Workbook', 'View'], details: ['Schema'] }, rows: rows };
    },
    one: function () {
      return { tiles: { levels: ['Table'], details: ['Schema'] }, rows: DATASETS.lineage().rows };
    }
  };

  var DSET = (DATASETS[params.get('data')] || DATASETS.lineage)();

  function cell (v) {
    if (v == null) return { value: null, nativeValue: null, formattedValue: '%null%' };
    return { value: v, nativeValue: v, formattedValue: String(v) };
  }

  var ORDER = ['levels', 'details', 'tooltip'];
  function allFields () {
    var out = [];
    ORDER.forEach(function (t) { (DSET.tiles[t] || []).forEach(function (n) { out.push({ tile: t, name: n }); }); });
    return out;
  }

  function buildTable () {
    var cols = allFields().map(function (f, i) {
      var name = RENAME && i === 0 ? 'Calculation_8812' : f.name;
      return { fieldName: name, fieldId: '[' + name + ']', dataType: 'string', index: i, src: f.name };
    });
    // like Tableau: one row per distinct combination
    var seen = {};
    var data = [];
    DSET.rows.forEach(function (r) {
      var k = cols.map(function (c) { return r[c.src]; }).join('\u0001');
      if (seen[k]) return;
      seen[k] = 1;
      data.push(cols.map(function (c) { return cell(r[c.src]); }));
    });
    return { columns: cols.map(function (c) { return { fieldName: c.fieldName, fieldId: c.fieldId, dataType: c.dataType, index: c.index }; }), data: data };
  }

  function encodings () {
    return allFields().map(function (f, i) {
      var name = RENAME && i === 0 ? 'Source table (renamed)' : f.name;
      var builtIn = f.tile === 'tooltip' ? 'tooltip' : null;
      return { id: builtIn || f.tile, type: builtIn || 'custom', field: { name: name, id: '[' + name + ']', role: 'dimension' } };
    });
  }

  // ---- settings ----------------------------------------------------------
  function loadSettings () {
    try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { return {}; }
  }
  var pending = loadSettings();
  var settingsHandlers = [];
  window.addEventListener('storage', function (e) {
    if (e.key === SET_KEY) {
      pending = loadSettings();
      settingsHandlers.forEach(function (h) { h({}); });
    }
  });

  var configureFn = null;
  var dialogResolve = null;
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'dl-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'dl-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed', ParameterChanged: 'parameter-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    SelectionUpdateType: { Replace: 'select-replace' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        return Promise.resolve();
      },
      initializeDialogAsync: function () {
        return Promise.resolve(localStorage.getItem(PAYLOAD_KEY) || '');
      },
      settings: {
        get: function (k) { return pending[k]; },
        set: function (k, v) { pending[k] = v; },
        getAll: function () { return pending; },
        saveAsync: function () {
          var snap = JSON.stringify(pending);
          return new Promise(function (resolve) {
            setTimeout(function () {
              localStorage.setItem(SET_KEY, snap);
              settingsHandlers.forEach(function (h) { h({}); });
              resolve();
            }, 0);
          });
        },
        addEventListener: function (type, h) { settingsHandlers.push(h); }
      },
      worksheetContent: {
        worksheet: {
          name: 'Mock sheet',
          addEventListener: function () {},
          getVisualSpecificationAsync: function () {
            return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: encodings() }] });
          },
          getSummaryDataReaderAsync: function () {
            var t = buildTable();
            return Promise.resolve({
              getAllPagesAsync: function () { return Promise.resolve(t); },
              releaseAsync: function () { return Promise.resolve(); }
            });
          },
          selectMarksByValueAsync: function (sel) { console.log('mock selectMarksByValueAsync', JSON.stringify(sel)); return Promise.resolve(); },
          clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); return Promise.resolve(); },
          getParametersAsync: function () { return Promise.resolve(MOCK_PARAMS); }
        }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          var target = window.parent !== window ? window.parent : null;
          if (target) target.postMessage({ type: 'dl-open-dialog', url: url }, '*');
          else window.open(url, 'dl-dialog', 'width=620,height=780');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'dl-close-dialog' }, '*');
          else window.close();
        }
      }
    }
  };
})();
