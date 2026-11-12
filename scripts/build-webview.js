#!/usr/bin/env node
/**
 * build-webview.js — Skrip build inline modul webview untuk Dependency Graph Visualizer (Task 14.2).
 *
 * Tujuan:
 *  - Membundel modul CommonJS `src/webview/*.js` menjadi SATU blok <script> IIFE inline
 *    yang mengekspos namespace global `window.CIViz`. Ini WAJIB inline (bukan <script src>)
 *    karena CSP webview melarang sumber daya jaringan: `default-src 'none'; script-src 'unsafe-inline'`.
 *  - Membaca template dari `webview.src.html` (sumber kebenaran) dan menulis hasil ke
 *    `webview.html`. Placeholder `__DAGRE_LIB__` & `__CI_DATA__` DIBIARKAN utuh; keduanya
 *    di-inject saat runtime oleh `extension.js getMainHtml`.
 *
 * Strategi bundle (mini CommonJS runtime):
 *  - Setiap file modul dibungkus sebagai `function (module, exports, require) { ...isi file... }`
 *    dan didaftarkan pada map `__modules['namamodul']`.
 *  - Sebuah `localRequire(name)` resolve nama relatif ('./x' -> 'x') dan meng-cache hasil,
 *    sehingga `require('./types')` di dalam modul berfungsi persis seperti di Node.
 *  - `layoutEngine.getDagre()` mencari global `dagre` lebih dulu (di-inject via __DAGRE_LIB__),
 *    baru jatuh ke `require` — di webview global `dagre` yang dipakai.
 *  - Namespace `window.CIViz` merangkum export modul kunci (build, createGraphView, filter, dll.).
 *
 * Requirements terkait: 8.1, 8.2, 8.3, 8.4 (100% offline, patuh CSP, pustaka lokal, render lokal).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXT_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_DIR = path.join(EXT_ROOT, 'src', 'webview');
const SRC_TEMPLATE = path.join(EXT_ROOT, 'webview.src.html');
const OUT_HTML = path.join(EXT_ROOT, 'webview.html');
const MODULES_PLACEHOLDER = '__WEBVIEW_MODULES__';

/**
 * Urutan modul sesuai dependensi. Nama = nama file tanpa ekstensi (dipakai sebagai key
 * `__modules` & sebagai target `require('./<nama>')`).
 * @type {string[]}
 */
const MODULE_ORDER = [
  'i18n',
  'types',
  'openFileMsg',
  'graphModelBuilder',
  'edgeFilter',
  'highlight',
  'interaction',
  'layoutEngine',
  'graphView',
  'simUI',
];

/**
 * Hapus file sampah verifikasi (`__verify_*.js` / `__verify_*.cjs`) di src/webview agar
 * tidak ikut terbundel.
 * @returns {string[]} daftar nama file yang dihapus.
 */
function cleanJunk() {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(WEBVIEW_DIR);
  } catch (e) {
    return removed;
  }
  for (const name of entries) {
    if (/^__verify_.*\.(js|cjs)$/.test(name)) {
      try {
        fs.unlinkSync(path.join(WEBVIEW_DIR, name));
        removed.push(name);
      } catch (e) {
        // abaikan kegagalan hapus; tidak fatal.
      }
    }
  }
  return removed;
}

/**
 * Baca isi sebuah modul webview.
 * @param {string} name nama modul (tanpa ekstensi).
 * @returns {string} isi file.
 */
function readModule(name) {
  const p = path.join(WEBVIEW_DIR, name + '.js');
  return fs.readFileSync(p, 'utf-8');
}

/**
 * Bangun blok IIFE bundle yang mendaftarkan semua modul & mengekspos window.CIViz.
 * @returns {string} kode JS (belum dibungkus tag <script>).
 */
function buildBundleSource() {
  const parts = [];
  parts.push('(function (global) {');
  parts.push('  "use strict";');
  parts.push('  var __modules = Object.create(null);');
  parts.push('  var __cache = Object.create(null);');
  parts.push('  function __normalize(name) {');
  parts.push('    return String(name).replace(/^\\.\\//, "").replace(/\\.js$/, "");');
  parts.push('  }');
  parts.push('  function __require(name) {');
  parts.push('    var key = __normalize(name);');
  parts.push('    if (__cache[key]) { return __cache[key].exports; }');
  parts.push('    var factory = __modules[key];');
  parts.push('    if (!factory) { throw new Error("CIViz bundle: modul tidak ditemukan: " + key); }');
  parts.push('    var module = { exports: {} };');
  parts.push('    __cache[key] = module;');
  parts.push('    factory(module, module.exports, __require);');
  parts.push('    return module.exports;');
  parts.push('  }');
  parts.push('  function __define(name, factory) { __modules[name] = factory; }');
  parts.push('');

  for (const name of MODULE_ORDER) {
    const code = readModule(name);
    parts.push('  // ===== module: ' + name + ' =====');
    parts.push('  __define(' + JSON.stringify(name) + ', function (module, exports, require) {');
    parts.push(code);
    parts.push('  });');
    parts.push('');
  }

  // Rakit namespace publik window.CIViz.
  parts.push('  var _i18n = __require("i18n");');
  parts.push('  var _types = __require("types");');
  parts.push('  var _openFileMsg = __require("openFileMsg");');
  parts.push('  var _builder = __require("graphModelBuilder");');
  parts.push('  var _edgeFilter = __require("edgeFilter");');
  parts.push('  var _highlight = __require("highlight");');
  parts.push('  var _interaction = __require("interaction");');
  parts.push('  var _layout = __require("layoutEngine");');
  parts.push('  var _graphView = __require("graphView");');
  parts.push('  var _simUI = __require("simUI");');
  parts.push('');
  parts.push('  global.CIViz = {');
  parts.push('    // i18n');
  parts.push('    setLanguage: _i18n.setLanguage,');
  parts.push('    getLanguage: _i18n.getLanguage,');
  parts.push('    t: _i18n.t,');
  parts.push('    // GraphModelBuilder');
  parts.push('    build: _builder.build,');
  parts.push('    // GraphView (DOM)');
  parts.push('    createGraphView: _graphView.createGraphView,');
  parts.push('    computeNeighbors: _graphView.computeNeighbors,');
  parts.push('    colorForNodeType: _graphView.colorForNodeType,');
  parts.push('    styleForEdgeType: _graphView.styleForEdgeType,');
  parts.push('    statusBadgeStyle: _graphView.statusBadgeStyle,');
  parts.push('    // simUI (Panel Skenario & Mode Simulasi)');
  parts.push('    createSimUI: _simUI.createSimUI,');
  parts.push('    normalizeScenario: _simUI.normalizeScenario,');
  parts.push('    // EdgeFilterBar');
  parts.push('    deriveFilters: _edgeFilter.deriveFilters,');
  parts.push('    initialEnabledTypes: _edgeFilter.initialEnabledTypes,');
  parts.push('    visibleEdges: _edgeFilter.visibleEdges,');
  parts.push('    toggleType: _edgeFilter.toggleType,');
  parts.push('    // openFile message builder');
  parts.push('    buildOpenFileMsg: _openFileMsg.buildOpenFileMsg,');
  parts.push('    // highlight');
  parts.push('    computeHighlight: _highlight.computeHighlight,');
  parts.push('    clearHighlight: _highlight.clearHighlight,');
  parts.push('    // interaction (zoom/pan)');
  parts.push('    clampZoom: _interaction.clampZoom,');
  parts.push('    applyPan: _interaction.applyPan,');
  parts.push('    // layout');
  parts.push('    layout: _layout.layout,');
  parts.push('    // constants');
  parts.push('    NODE_TYPES: _types.NODE_TYPES,');
  parts.push('    NODE_TYPE_LIST: _types.NODE_TYPE_LIST,');
  parts.push('    EDGE_TYPES: _types.EDGE_TYPES,');
  parts.push('    EDGE_TYPE_LIST: _types.EDGE_TYPE_LIST,');
  parts.push('    MAX_NODES: _types.MAX_NODES,');
  parts.push('  };');
  parts.push('})(typeof window !== "undefined" ? window : this);');

  return parts.join('\n');
}

function main() {
  const removed = cleanJunk();
  if (removed.length) {
    console.log('[build-webview] Menghapus file sampah: ' + removed.join(', '));
  }

  if (!fs.existsSync(SRC_TEMPLATE)) {
    console.error('[build-webview] ERROR: template sumber tidak ditemukan: ' + SRC_TEMPLATE);
    console.error('  Buat webview.src.html terlebih dahulu (template dengan placeholder ' + MODULES_PLACEHOLDER + ').');
    process.exit(1);
  }

  const template = fs.readFileSync(SRC_TEMPLATE, 'utf-8');
  if (template.indexOf(MODULES_PLACEHOLDER) === -1) {
    console.error('[build-webview] ERROR: placeholder ' + MODULES_PLACEHOLDER + ' tidak ada pada webview.src.html.');
    process.exit(1);
  }

  const bundle = buildBundleSource();

  // Replace HANYA __WEBVIEW_MODULES__; sisakan __DAGRE_LIB__ & __CI_DATA__ untuk runtime.
  // Pakai bentuk fungsi replacer agar pola `$` di dalam bundle diperlakukan literal.
  const output = template.replace(MODULES_PLACEHOLDER, function () { return bundle; });

  fs.writeFileSync(OUT_HTML, output, 'utf-8');

  const sizeKb = (Buffer.byteLength(output, 'utf-8') / 1024).toFixed(1);
  console.log('[build-webview] Menulis ' + OUT_HTML + ' (' + sizeKb + ' KB).');
  console.log('[build-webview] Modul terbundel (' + MODULE_ORDER.length + '): ' + MODULE_ORDER.join(', '));

  // Sanity: pastikan placeholder runtime masih utuh pada output.
  const stillHasDagre = output.indexOf('__DAGRE_LIB__') !== -1;
  const stillHasCiData = output.indexOf('__CI_DATA__') !== -1;
  console.log('[build-webview] __DAGRE_LIB__ utuh: ' + stillHasDagre + ' | __CI_DATA__ utuh: ' + stillHasCiData);
  if (!stillHasDagre || !stillHasCiData) {
    console.warn('[build-webview] PERINGATAN: salah satu placeholder runtime hilang dari output.');
  }
}

main();
