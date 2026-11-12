/**
 * graphView.js — GraphView: render SVG graf dependency (layer DOM) untuk Dependency Graph Visualizer.
 *
 * Modul ini adalah SATU-SATUNYA modul webview yang menyentuh DOM/SVG. Ia dibuat sebagai
 * factory `createGraphView(container, opts)` sehingga dapat diuji headless via jsdom
 * (dengan menyuntik `opts.doc`). Semua elemen SVG memakai namespace SVG yang benar
 * ('http://www.w3.org/2000/svg') agar valid di jsdom maupun webview asli.
 *
 * Tanggung jawab (Task 11.1/11.2/11.3/11.5):
 *  - 11.1 render node/edge SVG per tipe (bentuk/warna berbeda konsisten), label, marker panah
 *    source→target, penanda error (error_file) & unresolved (needs). (Req 1.2,1.3,1.4,1.5,7.1,7.5)
 *  - 11.2 wiring filter (setVisibleEdgeTypes), highlight (selectNode/deselect), zoom/pan
 *    (setZoom/zoomBy/pan → transform pada #viewport). (Req 1.6,1.7,2.2,2.3,2.4,5.1-5.6,3.1)
 *  - 11.3 status render: empty/invalid/over-limit + indikator proses (showLoading/hideLoading). (Req 1.8,1.9,6.5,6.6)
 *  - 11.5 legend keterangan node & edge per tipe + penanda error/unresolved. (Req 1.4,1.5,7.1,7.5)
 *
 * File ini di-`require` langsung oleh test headless dan di-inline ke `webview.html` saat build
 * (patuh CSP & 100% offline, Req 8). Tidak mengubah modul lain.
 */

'use strict';

const {
  NODE_TYPES,
  NODE_TYPE_LIST,
  EDGE_TYPES,
  EDGE_TYPE_LIST,
} = require('./types');
const { layout } = require('./layoutEngine');
const {
  visibleEdges: computeVisibleEdges,
} = require('./edgeFilter');
const { computeHighlight, clearHighlight } = require('./highlight');
const { clampZoom, applyPan, zoomAtPoint, fitView } = require('./interaction');
const { buildOpenFileMsg } = require('./openFileMsg');
const { t: L } = require('./i18n');

/** Namespace SVG standar. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Peta warna per tipe Node (Req 1.4). Nilai dipilih agar kontras & berbeda satu sama lain,
 * konsisten untuk setiap tipe. `error_file` dipisahkan (merah) untuk mempermudah dibedakan.
 * @type {Object<string, string>}
 */
const NODE_COLORS = {
  [NODE_TYPES.ROOT_FILE]: '#2e7d32',    // hijau tua — file entry
  [NODE_TYPES.INCLUDE_FILE]: '#1565c0', // biru — file include
  [NODE_TYPES.ERROR_FILE]: '#c62828',   // merah — file error
  [NODE_TYPES.TEMPLATE]: '#6a1b9a',     // ungu — template
  [NODE_TYPES.JOB]: '#ef6c00',          // oranye — job
  [NODE_TYPES.STAGE]: '#00838f',        // teal — stage
  [NODE_TYPES.CHILD_PIPELINE]: '#ad1457', // magenta — pipeline downstream (child / multi-project)
  [NODE_TYPES.DYNAMIC_CHILD]: '#b28704',  // emas gelap — child dinamis (dibuat saat runtime)
};

/**
 * Peta bentuk per tipe Node (Req 1.4). Bentuk berbeda memperkuat keterbedaan
 * di luar warna (mendukung pengamat buta warna).
 *  - 'rect'    : persegi (file)
 *  - 'ellipse' : elips (job)
 *  - 'diamond' : belah ketupat (template)
 *  - 'hexagon' : segienam (stage)
 * @type {Object<string, string>}
 */
const NODE_SHAPES = {
  [NODE_TYPES.ROOT_FILE]: 'rect',
  [NODE_TYPES.INCLUDE_FILE]: 'rect',
  [NODE_TYPES.ERROR_FILE]: 'rect',
  [NODE_TYPES.TEMPLATE]: 'diamond',
  [NODE_TYPES.JOB]: 'ellipse',
  [NODE_TYPES.STAGE]: 'hexagon',
  [NODE_TYPES.CHILD_PIPELINE]: 'octagon',
  [NODE_TYPES.DYNAMIC_CHILD]: 'octagon',
};

/**
 * Gaya per tipe Edge (Req 1.5): warna & pola garis (dash) berbeda konsisten per tipe.
 * @type {Object<string, {color:string, dash:string, width:number}>}
 */
const EDGE_STYLES = {
  [EDGE_TYPES.INCLUDES]:        { color: '#4aa3ff', dash: '',        width: 2.5 },
  [EDGE_TYPES.DEFINES_TEMPLATE]:{ color: '#b57edc', dash: '4 3',     width: 2 },
  [EDGE_TYPES.DEFINES_JOB]:     { color: '#ffa04a', dash: '7 3',     width: 2 },
  [EDGE_TYPES.EXTENDS]:         { color: '#e879f9', dash: '2 4',     width: 2 },
  [EDGE_TYPES.NEEDS]:           { color: '#42d17a', dash: '',        width: 3 },
  [EDGE_TYPES.STAGE_CONTAINS]:  { color: '#26c6da', dash: '5 4',     width: 2 },
  [EDGE_TYPES.TRIGGERS]:        { color: '#ff4081', dash: '',        width: 3.5 },
  [EDGE_TYPES.CHILD_CONTAINS]:  { color: '#ce93d8', dash: '3 3',     width: 1.5 },
};

/** Gaya khusus untuk edge needs yang tidak terselesaikan (Req 7.5) — merah putus-putus. */
const UNRESOLVED_STYLE = { color: '#ff5252', dash: '4 3', width: 2.5 };

/** Warna fallback untuk tipe tak dikenal. */
const FALLBACK_NODE_COLOR = '#607d8b';
const FALLBACK_EDGE_STYLE = { color: '#9e9e9e', dash: '', width: 1.5 };

/** Ukuran box node default (selaras dengan LayoutEngine.DEFAULT_OPTS). */
const NODE_W = 160;
const NODE_H = 40;

/**
 * Helper murni: warna fill untuk sebuah tipe node (Req 1.4).
 * @param {string} type
 * @returns {string} kode warna hex.
 */
function colorForNodeType(type) {
  return Object.prototype.hasOwnProperty.call(NODE_COLORS, type)
    ? NODE_COLORS[type]
    : FALLBACK_NODE_COLOR;
}

/**
 * Helper murni: gaya garis untuk sebuah tipe edge (Req 1.5).
 * @param {string} type
 * @param {boolean} [unresolved] bila true, kembalikan gaya khusus unresolved (Req 7.5).
 * @returns {{color:string, dash:string, width:number}} salinan gaya (tak memutasi konstanta).
 */
function styleForEdgeType(type, unresolved) {
  if (unresolved) {
    return Object.assign({}, UNRESOLVED_STYLE);
  }
  const base = Object.prototype.hasOwnProperty.call(EDGE_STYLES, type)
    ? EDGE_STYLES[type]
    : FALLBACK_EDGE_STYLE;
  return Object.assign({}, base);
}

/**
 * Gaya badge per Status_Job untuk simulasi (Task 16, Req 12.1, 12.2, 14.5).
 *  - RUN     : hijau
 *  - SKIP    : abu
 *  - MANUAL  : biru
 *  - DELAYED : ungu
 *  - NEVER   : merah (garis silang/opacity di CSS)
 *  - error   : indikator error khusus (kuning/merah + '!')
 * Nilai sengaja injektif per status (warna & simbol berbeda) demi keterbedaan visual.
 * @type {Object<string, {color:string,label:string,symbol:string}>}
 */
const SIM_STATUS_STYLES = {
  RUN:     { color: '#2e7d32', label: 'RUN',     symbol: '\u2713' }, // ✓ hijau
  SKIP:    { color: '#757575', label: 'SKIP',    symbol: '\u2013' }, // – abu
  MANUAL:  { color: '#1565c0', label: 'MANUAL',  symbol: '\u25B6' }, // ▶ biru
  DELAYED: { color: '#6a1b9a', label: 'DELAYED', symbol: '\u23F1' }, // ⏱ ungu
  NEVER:   { color: '#c62828', label: 'NEVER',   symbol: '\u2715' }, // ✕ merah
};

/** Gaya khusus untuk indikator error simulasi (Req 14.5). */
const SIM_ERROR_STYLE = { color: '#e65100', label: 'ERROR', symbol: '!' };

/** Gaya fallback untuk status simulasi tak dikenal. */
const SIM_FALLBACK_STYLE = { color: '#607d8b', label: 'UNKNOWN', symbol: '?' };

/**
 * Helper murni: gaya badge untuk sebuah Status_Job hasil simulasi (Req 12.2, 14.5).
 * Mengembalikan salinan objek {color,label,symbol} agar konstanta tidak dimutasi.
 * Status tak dikenal → gaya fallback. Nilai 'error' (huruf besar/kecil) → gaya error.
 * @param {string} status
 * @returns {{color:string,label:string,symbol:string}}
 */
function statusBadgeStyle(status) {
  const key = status == null ? '' : String(status).toUpperCase();
  if (key === 'ERROR') {
    return Object.assign({}, SIM_ERROR_STYLE);
  }
  if (Object.prototype.hasOwnProperty.call(SIM_STATUS_STYLES, key)) {
    return Object.assign({}, SIM_STATUS_STYLES[key]);
  }
  return Object.assign({}, SIM_FALLBACK_STYLE);
}

/** Bentuk (shape) untuk sebuah tipe node. */
function shapeForNodeType(type) {
  return Object.prototype.hasOwnProperty.call(NODE_SHAPES, type)
    ? NODE_SHAPES[type]
    : 'rect';
}

/**
 * Ambil iterable [id, NodeVM] dari model.nodes (Map atau object literal by id).
 * @param {Map<string,Object>|Object<string,Object>} nodes
 * @returns {Array<[string, Object]>}
 */
function nodeEntries(nodes) {
  if (nodes instanceof Map) {
    return Array.from(nodes.entries());
  }
  if (nodes && typeof nodes === 'object') {
    return Object.keys(nodes).map((id) => [id, nodes[id]]);
  }
  return [];
}

/** Ambil satu NodeVM by id dari model.nodes (Map atau object). */
function getNode(nodes, id) {
  if (nodes instanceof Map) {
    return nodes.get(id);
  }
  if (nodes && typeof nodes === 'object') {
    return nodes[id];
  }
  return undefined;
}

/**
 * Factory GraphView.
 *
 * @param {Element} container  Elemen DOM tempat graf dirender.
 * @param {Object} [opts]
 * @param {Document} [opts.doc]         Document untuk membuat elemen (default: global `document`).
 * @param {(msg:Object)=>void} [opts.onOpenFile] callback saat node ber-path diklik; menerima pesan openFile.
 * @param {(nodeId:string|null)=>void} [opts.onSelect] callback saat seleksi node berubah (null saat deselect).
 * @returns {Object} instance GraphView dengan API render/setVisibleEdgeTypes/selectNode/zoom/pan/legend.
 */
function createGraphView(container, opts) {
  const options = opts || {};
  const doc =
    options.doc ||
    (typeof document !== 'undefined' ? document : undefined);

  if (!doc) {
    throw new Error('createGraphView: butuh Document (opts.doc) untuk membuat elemen.');
  }
  if (!container) {
    throw new Error('createGraphView: butuh container elemen DOM.');
  }

  const onOpenFile = typeof options.onOpenFile === 'function' ? options.onOpenFile : null;
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
  // Callback saat node job terpilih & ada hasil simulasi (Task 16, Req 12.3).
  const onSimSelect = typeof options.onSimSelect === 'function' ? options.onSimSelect : null;

  // ---- state internal ----
  let currentModel = null;   // BuildResult terakhir yang sukses (ok && !empty && !overLimit)
  let currentLayout = null;  // hasil layout(model)
  let enabledTypes = new Set(EDGE_TYPE_LIST); // tipe edge aktif (default semua, Req 2.6)
  let selectedId = null;     // node terpilih saat ini (null = tidak ada)
  let simResults = null;     // map { <jobName>: JobSimResult } dari simulasi (null = tak aktif, Task 16)
  let scale = 1;             // tingkat zoom (Req 1.6)
  let offset = { x: 0, y: 0 }; // pan offset (Req 1.7)
  let layoutDir = 'LR';      // arah layout: 'LR' (kiri->kanan) atau 'TB' (atas->bawah).
  let savedPositions = null; // posisi node hasil restore (persist) yang dipakai override layout.
  let contentW = 0;          // lebar konten graf terakhir (koordinat dunia) — untuk fit/zoom.
  let contentH = 0;          // tinggi konten graf terakhir (koordinat dunia).

  // Referensi elemen DOM yang dibangun render().
  let svgEl = null;
  let ctxMenuEl = null; // elemen context menu aktif (klik kanan node)
  let viewportEl = null;
  const nodeEls = new Map(); // id -> <g data-node-id>
  const edgeEls = new Map(); // edgeId -> <g data-edge-id>

  // ---- util pembuatan elemen ----
  function svg(tag, attrs) {
    const el = doc.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v != null) {
          el.setAttribute(k, String(v));
        }
      }
    }
    return el;
  }

  function html(tag, attrs) {
    const el = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k === 'text') {
          el.textContent = v;
        } else if (v != null) {
          el.setAttribute(k, String(v));
        }
      }
    }
    return el;
  }

  function clearContainer() {
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    svgEl = null;
    viewportEl = null;
    nodeEls.clear();
    edgeEls.clear();
  }

  // =========================================================================
  // TASK 11.3 — Status render & indikator proses
  // =========================================================================

  const MESSAGES = {
    empty: 'Tidak ada data graf untuk ditampilkan',       // Req 1.8
    invalid: 'Gagal memuat data graf',                    // Req 1.9
    overlimit: 'Ukuran graf melebihi batas maksimum (>1000 node)', // Req 6.6
  };

  /**
   * Render sebuah pesan status (empty/invalid/over-limit) tanpa render graf parsial (Req 1.8/1.9/6.6).
   * @param {'empty'|'invalid'|'overlimit'} kind
   */
  function renderMessage(kind) {
    clearContainer();
    const box = html('div', {
      class: 'graph-message graph-message-' + kind,
      'data-message-kind': kind,
      role: 'status',
    });
    box.textContent = Object.prototype.hasOwnProperty.call(MESSAGES, kind)
      ? L(MESSAGES[kind])
      : L(MESSAGES.invalid);
    container.appendChild(box);
  }

  /** Tampilkan indikator proses selama render (Req 6.5). */
  function showLoading() {
    if (container.querySelector('.graph-loading')) {
      return;
    }
    const loader = html('div', {
      class: 'graph-loading',
      role: 'status',
      'aria-live': 'polite',
    });
    const spinner = html('div', { class: 'graph-loading-spinner' });
    const label = html('div', { class: 'graph-loading-label', text: L('Merender graf…') });
    loader.appendChild(spinner);
    loader.appendChild(label);
    container.appendChild(loader);
  }

  /** Hapus indikator proses (Req 6.5). */
  function hideLoading() {
    const loaders = container.querySelectorAll('.graph-loading');
    for (let i = 0; i < loaders.length; i += 1) {
      const el = loaders[i];
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
  }

  // =========================================================================
  // TASK 11.1 — Render node/edge SVG per tipe
  // =========================================================================

  /** Bangun definisi <marker> panah — satu per tipe edge (+ unresolved) agar warna konsisten. */
  function buildDefs() {
    const defs = svg('defs');

    function addMarker(id, color) {
      const marker = svg('marker', {
        id,
        class: 'edge-arrow',
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto-start-reverse',
        markerUnits: 'userSpaceOnUse',
      });
      const path = svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: color });
      marker.appendChild(path);
      defs.appendChild(marker);
    }

    for (const type of EDGE_TYPE_LIST) {
      addMarker('arrow-' + type, styleForEdgeType(type).color);
    }
    addMarker('arrow-unresolved', UNRESOLVED_STYLE.color);
    return defs;
  }

  /**
   * Bangun elemen bentuk node sesuai tipe, ter-center pada (0,0) berukuran w×h.
   * @returns {Element} elemen bentuk SVG.
   */
  function buildNodeShape(type, w, h) {
    const shape = shapeForNodeType(type);
    const fill = colorForNodeType(type);
    const hw = w / 2;
    const hh = h / 2;
    const common = { class: 'node-shape', fill, stroke: '#00000055', 'stroke-width': 1 };
    if (type === NODE_TYPES.DYNAMIC_CHILD) {
      // Garis putus-putus terang: konten child belum diketahui (dibuat saat runtime).
      common.stroke = '#ffe082';
      common['stroke-width'] = 2;
      common['stroke-dasharray'] = '5 3';
    }

    if (shape === 'octagon') {
      const cut = Math.min(hw, hh) * 0.6;
      const pts = [
        -hw + cut, -hh, hw - cut, -hh, hw, -hh + cut, hw, hh - cut,
        hw - cut, hh, -hw + cut, hh, -hw, hh - cut, -hw, -hh + cut,
      ].join(' ');
      return svg('polygon', Object.assign({ points: pts }, common));
    }
    if (shape === 'ellipse') {
      return svg('ellipse', Object.assign({ cx: 0, cy: 0, rx: hw, ry: hh }, common));
    }
    if (shape === 'diamond') {
      const pts = [0, -hh, hw, 0, 0, hh, -hw, 0].join(' ');
      return svg('polygon', Object.assign({ points: pts }, common));
    }
    if (shape === 'hexagon') {
      const inset = hw * 0.4;
      const pts = [
        -hw + inset, -hh,
        hw - inset, -hh,
        hw, 0,
        hw - inset, hh,
        -hw + inset, hh,
        -hw, 0,
      ].join(' ');
      return svg('polygon', Object.assign({ points: pts }, common));
    }
    // default: rect
    return svg('rect', Object.assign({
      x: -hw, y: -hh, width: w, height: h, rx: 4, ry: 4,
    }, common));
  }

  /**
   * Render satu node → <g data-node-id data-node-type> berisi bentuk, label, & (jika error_file)
   * penanda error yang selalu ada (Req 7.1). Diposisikan via transform translate(x,y).
   */
  function renderNode(id, vm, pos) {
    const type = vm && vm.type;
    const g = svg('g', {
      class: 'graph-node node-type-' + type,
      'data-node-id': id,
      'data-node-type': type,
      transform: 'translate(' + pos.x + ',' + pos.y + ')',
    });

    g.appendChild(buildNodeShape(type, pos.w || NODE_W, pos.h || NODE_H));

    // Label (Req 1.3).
    const label = svg('text', {
      class: 'node-label',
      x: 0,
      y: 0,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: '#ffffff',
      'font-size': 12,
    });
    label.textContent = (vm && vm.label != null) ? vm.label : id;
    g.appendChild(label);

    // Penanda error untuk error_file — selalu ada di semua zoom & keadaan (Req 7.1).
    if (type === NODE_TYPES.ERROR_FILE || (vm && vm.hasErrorMarker)) {
      const hw = (pos.w || NODE_W) / 2;
      const hh = (pos.h || NODE_H) / 2;
      const marker = svg('g', { class: 'error-marker' });
      marker.appendChild(svg('circle', {
        cx: hw - 6, cy: -hh + 6, r: 7, fill: '#ffeb3b', stroke: '#c62828', 'stroke-width': 1.5,
      }));
      const bang = svg('text', {
        x: hw - 6, y: -hh + 6, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: '#c62828', 'font-size': 10, 'font-weight': 'bold',
      });
      bang.textContent = '!';
      marker.appendChild(bang);
      g.appendChild(marker);
    }

    // Klik kiri (tanpa drag) → seleksi saja. Klik kanan → context menu.
    // Drag → reposition node (edge ikut menyesuaikan).
    attachNodeInteractions(g, id);

    return g;
  }

  /**
   * Pasang interaksi per-node: klik-kiri select (bukan drag), klik-kanan context menu,
   * dan drag untuk memindahkan node. Aman di jsdom (guard addEventListener).
   */
  function attachNodeInteractions(g, id) {
    if (!g || typeof g.addEventListener !== 'function') return;

    let dragging = false;
    let moved = false;
    let startSX = 0, startSY = 0;   // posisi mouse layar saat mousedown
    let startNX = 0, startNY = 0;   // posisi node (dunia) saat mousedown

    g.addEventListener('mousedown', function (ev) {
      if (ev && ev.button !== 0) return; // hanya tombol kiri untuk drag
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      dragging = true; moved = false;
      startSX = (ev && typeof ev.clientX === 'number') ? ev.clientX : 0;
      startSY = (ev && typeof ev.clientY === 'number') ? ev.clientY : 0;
      const p = currentLayout && currentLayout.positions ? currentLayout.positions[id] : null;
      startNX = p ? p.x : 0; startNY = p ? p.y : 0;
      if (svgEl) svgEl.style.cursor = 'grabbing';
    });

    // gerakan & pelepasan dipasang di dokumen agar drag mulus keluar node.
    const onMove = function (ev) {
      if (!dragging) return;
      const cx = (ev && typeof ev.clientX === 'number') ? ev.clientX : startSX;
      const cy = (ev && typeof ev.clientY === 'number') ? ev.clientY : startSY;
      const dxScreen = cx - startSX, dyScreen = cy - startSY;
      if (Math.abs(dxScreen) + Math.abs(dyScreen) > 3) moved = true;
      // konversi delta layar → delta dunia (bagi skala).
      const nx = startNX + dxScreen / (scale || 1);
      const ny = startNY + dyScreen / (scale || 1);
      moveNode(id, nx, ny);
    };
    const onUp = function (ev) {
      if (!dragging) return;
      dragging = false;
      if (svgEl) svgEl.style.cursor = '';
      if (!moved) {
        // klik biasa (tanpa geser) → seleksi saja.
        handleNodeClick(id);
      }
    };
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('mousemove', onMove);
      doc.addEventListener('mouseup', onUp);
    }

    g.addEventListener('contextmenu', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      const cx = (ev && typeof ev.clientX === 'number') ? ev.clientX : 0;
      const cy = (ev && typeof ev.clientY === 'number') ? ev.clientY : 0;
      showContextMenu(id, cx, cy);
    });
  }

  /**
   * Pindahkan node ke posisi dunia (nx,ny): update transform node & titik-titik edge
   * yang menyentuhnya (garis lurus dari pusat-ke-pusat agar sederhana & jelas).
   */
  function moveNode(id, nx, ny) {
    if (!currentLayout || !currentLayout.positions) return;
    const p = currentLayout.positions[id];
    if (!p) return;
    p.x = nx; p.y = ny;
    const g = nodeEls.get(id);
    if (g) g.setAttribute('transform', 'translate(' + nx + ',' + ny + ')');
    // Perbarui edge yang terhubung: gambar garis lurus pusat→pusat.
    if (currentModel && Array.isArray(currentModel.edges)) {
      for (const edge of currentModel.edges) {
        if (edge.source !== id && edge.target !== id) continue;
        const sp = currentLayout.positions[edge.source];
        const tp = currentLayout.positions[edge.target];
        if (!sp || !tp) continue;
        const gEdge = edgeEls.get(edge.id);
        if (!gEdge) continue;
        const path = gEdge.querySelector('.edge-path');
        if (path) path.setAttribute('d', 'M' + sp.x + ',' + sp.y + ' L' + tp.x + ',' + tp.y);
      }
    }
  }

  /** Tampilkan context menu kustom (klik kanan node) dengan aksi Open/Focus/Copy. */
  function showContextMenu(nodeId, screenX, screenY) {
    removeContextMenu();
    const vm = currentModel ? getNode(currentModel.nodes, nodeId) : null;
    const menu = html('div', { class: 'graph-ctx-menu' });
    menu.style.position = 'fixed';
    menu.style.left = screenX + 'px';
    menu.style.top = screenY + 'px';
    menu.style.zIndex = '9999';

    function item(labelText, enabled, fn) {
      const it = html('div', { class: 'graph-ctx-item' + (enabled ? '' : ' disabled') });
      it.textContent = labelText;
      if (enabled) {
        it.addEventListener('click', function (ev) {
          if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
          removeContextMenu();
          fn();
        });
      }
      menu.appendChild(it);
    }

    const hasPath = !!(vm && vm.path);
    item(hasPath ? 'Open file' : L('Open file (tak tersedia)'), hasPath, function () {
      if (onOpenFile) { const m = buildOpenFileMsg(vm); if (m) onOpenFile(m); }
    });
    item('Focus & highlight', true, function () { selectNode(nodeId); });
    item('Copy path', hasPath, function () {
      try { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(vm.path); } catch (e) {}
    });

    (doc.body || doc.documentElement).appendChild(menu);
    // Tutup saat klik di luar.
    const closer = function () { removeContextMenu(); };
    setTimeout(function () {
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('click', closer, { once: true });
      }
    }, 0);
    ctxMenuEl = menu;
  }

  function removeContextMenu() {
    if (ctxMenuEl && ctxMenuEl.parentNode) ctxMenuEl.parentNode.removeChild(ctxMenuEl);
    ctxMenuEl = null;
  }

  /**
   * Render satu edge → <g data-edge-id data-edge-type> berisi <path> + panah marker.
   * Edge unresolved (needs tanpa target-node) diberi class 'unresolved' + gaya berbeda (Req 7.5).
   */
  function renderEdge(edge, points) {
    const type = edge.type;
    const unresolved = !!edge.unresolved;
    const style = styleForEdgeType(type, unresolved);

    const g = svg('g', {
      class: 'graph-edge edge-type-' + type + (unresolved ? ' unresolved' : ''),
      'data-edge-id': edge.id,
      'data-edge-type': type,
    });

    const d = pointsToPath(points);
    const markerId = unresolved ? 'url(#arrow-unresolved)' : 'url(#arrow-' + type + ')';
    const path = svg('path', {
      class: 'edge-path',
      d,
      fill: 'none',
      stroke: style.color,
      'stroke-width': style.width,
      'stroke-dasharray': style.dash || null,
      'marker-end': markerId,
    });
    g.appendChild(path);
    return g;
  }

  /** Ubah deret titik menjadi atribut path `d`. Fallback ke garis lurus bila titik <2. */
  function pointsToPath(points) {
    const pts = Array.isArray(points) ? points.filter((p) => p && typeof p.x === 'number') : [];
    if (pts.length < 2) {
      // Tanpa titik dari layout: gambar path minimal (tak terlihat) yang tetap valid.
      if (pts.length === 1) {
        return 'M' + pts[0].x + ',' + pts[0].y;
      }
      return 'M0,0';
    }
    let d = 'M' + pts[0].x + ',' + pts[0].y;
    for (let i = 1; i < pts.length; i += 1) {
      d += ' L' + pts[i].x + ',' + pts[i].y;
    }
    return d;
  }

  /**
   * render(model) — pintu masuk utama (Req 1.1..1.10, 6.5, 6.6).
   * Menangani status (invalid/empty/over-limit) atau membangun SVG lengkap.
   * @param {import('./types').BuildResult} model
   */
  function render(model) {
    showLoading(); // Req 6.5 — indikator proses di awal.
    try {
      // Reset state seleksi tiap render penuh (render baru = data baru).
      selectedId = null;
      currentModel = null;
      currentLayout = null;

      if (!model || model.ok === false) {
        renderMessage('invalid'); // Req 1.9
        return;
      }
      if (model.overLimit) {
        renderMessage('overlimit'); // Req 6.6
        return;
      }
      if (model.empty) {
        renderMessage('empty'); // Req 1.8
        return;
      }

      currentModel = model;
      // Reset filter ke semua aktif tiap render penuh (Req 2.6).
      enabledTypes = new Set(EDGE_TYPE_LIST);

      currentLayout = layout(model, { rankdir: layoutDir });
      if (savedPositions) {
        for (const id of Object.keys(savedPositions)) {
          if (currentLayout.positions[id]) {
            currentLayout.positions[id].x = savedPositions[id].x;
            currentLayout.positions[id].y = savedPositions[id].y;
          }
        }
        savedPositions = null;
      }
      buildSvg(model, currentLayout);
    } finally {
      hideLoading(); // Req 6.5 — hapus indikator di akhir.
    }
  }

  /** Bangun struktur <svg> + #viewport + edges + nodes dari model & hasil layout. */
  function buildSvg(model, lay) {
    clearContainer();

    const width = Number.isFinite(lay.width) ? lay.width : 800;
    const height = Number.isFinite(lay.height) ? lay.height : 600;

    // Simpan dimensi konten untuk fit-to-view & zoom ke tengah viewport.
    contentW = width;
    contentH = height;

    svgEl = svg('svg', {
      class: 'graph-svg',
      width: '100%',
      height: '100%',
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'xMidYMid meet',
    });
    svgEl.appendChild(buildDefs());

    // #viewport — <g> pembungkus untuk transform zoom/pan (Req 1.6/1.7).
    viewportEl = svg('g', { id: 'viewport' });
    svgEl.appendChild(viewportEl);

    // Layer edge di bawah node.
    const edgeLayer = svg('g', { class: 'edge-layer' });
    const nodeLayer = svg('g', { class: 'node-layer' });
    viewportEl.appendChild(edgeLayer);
    viewportEl.appendChild(nodeLayer);

    // Peta points edge dari hasil layout (key source->target). Layout hanya mengembalikan
    // edge yang kedua endpoint-nya ada; edge unresolved (needs tanpa target) tidak punya points.
    const layoutEdgePoints = new Map();
    for (const le of (lay.edges || [])) {
      layoutEdgePoints.set(le.source + '\u0000' + le.target, le.points);
    }

    // Render nodes.
    for (const [id, vm] of nodeEntries(model.nodes)) {
      const pos = lay.positions[id];
      if (!pos) {
        continue;
      }
      const g = renderNode(id, vm, pos);
      nodeLayer.appendChild(g);
      nodeEls.set(id, g);
    }

    // Render edges (termasuk unresolved). Untuk unresolved, gambar garis pendek dari pusat source.
    for (const edge of (model.edges || [])) {
      let points = layoutEdgePoints.get(edge.source + '\u0000' + edge.target);
      if ((!points || points.length < 2) && edge.unresolved) {
        const sp = lay.positions[edge.source];
        if (sp) {
          // Stub keluar dari sisi kanan node source untuk menandai relasi tak terselesaikan.
          points = [
            { x: sp.x + (sp.w || NODE_W) / 2, y: sp.y },
            { x: sp.x + (sp.w || NODE_W) / 2 + 40, y: sp.y },
          ];
        }
      }
      const g = renderEdge(edge, points);
      edgeLayer.appendChild(g);
      edgeEls.set(edge.id, g);
    }

    container.appendChild(svgEl);

    // Terapkan filter & transform awal.
    applyEdgeVisibility();
    applyTransform();

    // Pandang awal "zoom-in" agar node langsung terbaca detail (user tak perlu zoom manual).
    // Dibungkus try/catch agar aman di lingkungan headless (jsdom).
    try {
      initialView();
    } catch (e) {
      /* abaikan — lingkungan tanpa dimensi viewport nyata */
    }

    // Klik area kosong → deselect (Req 5.5).
    svgEl.addEventListener('click', function () {
      if (selectedId != null) {
        deselect();
      }
    });

    // Listener zoom/pan (guard aman jsdom).
    attachInteractionListeners();

    // Task 16: bila ada hasil simulasi aktif, terapkan ulang badge ke node baru.
    if (simResults) {
      applyAllSimBadges();
    }

    // v2.0.0 #8 — bangun ulang minimap bila diaktifkan.
    if (minimapEnabled) {
      try { buildMinimap(); } catch (e) { /* minimap opsional */ }
    }
  }

  // =========================================================================
  // TASK 11.2 — Wiring filter, highlight, interaction
  // =========================================================================

  /** Kumpulan seluruh id node saat ini. */
  function allNodeIds() {
    if (!currentModel) {
      return [];
    }
    return nodeEntries(currentModel.nodes).map(([id]) => id);
  }

  /** Edge yang terlihat saat ini (setelah filter tipe). */
  function currentVisibleEdges() {
    if (!currentModel) {
      return [];
    }
    return computeVisibleEdges(currentModel.edges, enabledTypes);
  }

  /**
   * setVisibleEdgeTypes(enabledTypesArg) — sembunyikan/tampilkan edge via data-edge-type
   * TANPA rebuild layout; node tetap tampil (Req 2.2, 2.3, 2.4). Recompute highlight bila ada seleksi.
   * @param {Set<string>|string[]} enabledTypesArg
   */
  function setVisibleEdgeTypes(enabledTypesArg) {
    if (enabledTypesArg instanceof Set) {
      enabledTypes = new Set(enabledTypesArg);
    } else if (Array.isArray(enabledTypesArg)) {
      enabledTypes = new Set(enabledTypesArg);
    } else {
      enabledTypes = new Set();
    }
    applyEdgeVisibility();
    if (selectedId != null) {
      applyHighlight(selectedId);
    }
  }

  /** Terapkan visibilitas edge berdasarkan enabledTypes ke DOM (display none/'' per data-edge-type). */
  function applyEdgeVisibility() {
    edgeEls.forEach((g) => {
      const type = g.getAttribute('data-edge-type');
      const visible = enabledTypes.has(type);
      if (visible) {
        g.style.display = '';
        g.removeAttribute('hidden');
      } else {
        g.style.display = 'none';
        g.setAttribute('hidden', 'hidden');
      }
    });
  }

  /** Tangani klik node: toggle seleksi + openFile bila ber-path (Req 3.1, 5.1, 5.6). */
  function handleNodeClick(id) {
    // Klik node terpilih lagi → deselect (Req 5.6/5.5).
    if (selectedId === id) {
      deselect();
    } else {
      selectNode(id);
    }

    // Klik kiri TIDAK lagi membuka file otomatis. Gunakan klik kanan (context menu)
    // untuk aksi Open File / Focus / Copy path (lihat showContextMenu).
  }

  /**
   * selectNode(nodeId) — pilih node: computeHighlight atas visibleEdges saat ini,
   * terapkan class highlighted/dimmed (Req 5.1-5.4), panggil onSelect.
   * @param {string} nodeId
   */
  function selectNode(nodeId) {
    selectedId = nodeId;
    applyHighlight(nodeId);
    if (onSelect) {
      onSelect(nodeId);
    }
    // Task 16 (Req 12.3): bila node job terpilih & ada hasil simulasi, beri tahu host
    // untuk menampilkan alasan + when efektif.
    if (onSimSelect && simResults) {
      const g = nodeEls.get(nodeId);
      const name = jobNameForNodeEl(g);
      if (name != null) {
        const result = simResultForJobName(name);
        if (result) {
          onSimSelect(name, result);
        }
      }
    }
  }

  /** Batalkan seleksi → hapus semua class highlight/dim (Req 5.5). Kamera tidak diubah. */
  function deselect() {
    selectedId = null;
    clearHighlight(); // (murni; dipanggil untuk konsistensi kontrak)
    clearHighlightClasses();
    if (onSelect) {
      onSelect(null);
    }
  }

  /** Hitung & terapkan kelas highlighted/dimmed pada node & edge untuk sebuah seleksi. */
  function applyHighlight(nodeId) {
    const vEdges = currentVisibleEdges();
    const state = computeHighlight(nodeId, allNodeIds(), vEdges);

    // Node.
    nodeEls.forEach((g, id) => {
      g.classList.remove('highlighted', 'dimmed');
      if (state.highlightedNodes.has(id)) {
        g.classList.add('highlighted');
      } else {
        // Node tak berelasi tetap tampil sebagai "bayangan" (samar), bukan hilang.
        g.classList.add('dimmed');
      }
    });

    // Edge: highlightedEdges berisi INDEKS pada vEdges. Petakan indeks → edge.id.
    const highlightedEdgeIds = new Set();
    for (const idx of state.highlightedEdges) {
      const e = vEdges[idx];
      if (e) {
        highlightedEdgeIds.add(e.id);
      }
    }
    edgeEls.forEach((g, edgeId) => {
      g.classList.remove('highlighted', 'dimmed');
      // Hanya edge yang saat ini terlihat yang ikut dinilai; edge tersembunyi biarkan tanpa kelas.
      const type = g.getAttribute('data-edge-type');
      if (!enabledTypes.has(type)) {
        return;
      }
      if (highlightedEdgeIds.has(edgeId)) {
        g.classList.add('highlighted');
      } else {
        g.classList.add('dimmed');
      }
    });

    // Catatan: klik node HANYA menyorot (highlight + dim). Kamera (zoom/pan) sengaja
    // TIDAK diubah agar tampilan tidak "kereset". User mengatur zoom/pan sendiri.
  }

  /** Hapus seluruh kelas highlight/dim (kembali normal, Req 5.5). */
  function clearHighlightClasses() {
    nodeEls.forEach((g) => g.classList.remove('highlighted', 'dimmed'));
    edgeEls.forEach((g) => g.classList.remove('highlighted', 'dimmed'));
  }

  // =========================================================================
  // TASK 16 — Badge status simulasi pada node job & detail alasan
  // =========================================================================

  /** Daftar semua kelas sim-status-* + sim-error yang mungkin dilekatkan ke node. */
  const SIM_CLASS_LIST = ['sim-status-RUN', 'sim-status-SKIP', 'sim-status-MANUAL',
    'sim-status-DELAYED', 'sim-status-NEVER', 'sim-error'];

  /**
   * Ambil nama job dari id node graf ("job:build" → "build"). Node non-job → null.
   * @param {Element} g elemen <g> node.
   * @returns {string|null}
   */
  function jobNameForNodeEl(g) {
    if (!g || g.getAttribute('data-node-type') !== NODE_TYPES.JOB) {
      return null;
    }
    const id = g.getAttribute('data-node-id') || '';
    return id.indexOf('job:') === 0 ? id.slice('job:'.length) : id;
  }

  /** Ambil JobSimResult dari simResults untuk sebuah nama job (null bila tak ada). */
  function simResultForJobName(name) {
    if (!simResults || name == null) {
      return null;
    }
    return Object.prototype.hasOwnProperty.call(simResults, name)
      ? simResults[name]
      : null;
  }

  /** Hapus badge & kelas simulasi dari satu node <g>. */
  function clearNodeSimBadge(g) {
    if (!g) {
      return;
    }
    for (const cls of SIM_CLASS_LIST) {
      g.classList.remove(cls);
    }
    g.classList.remove('sim-node');
    const badge = g.querySelector('.sim-badge');
    if (badge && badge.parentNode) {
      badge.parentNode.removeChild(badge);
    }
  }

  /** Hapus seluruh badge/kelas simulasi dari semua node (Req 12.5). */
  function clearAllSimBadges() {
    nodeEls.forEach((g) => clearNodeSimBadge(g));
  }

  /**
   * Terapkan badge/kelas simulasi ke satu node job berdasarkan JobSimResult.
   * Node error (result.error terisi) memakai indikator error khusus (Req 14.5).
   * @param {Element} g elemen node.
   * @param {Object} result JobSimResult.
   */
  function applyNodeSimBadge(g, result) {
    clearNodeSimBadge(g);
    if (!g || !result) {
      return;
    }
    const hasError = result.error != null && String(result.error).trim() !== '';
    const status = hasError ? 'ERROR' : result.status;
    const style = statusBadgeStyle(status);

    g.classList.add('sim-node');
    if (hasError) {
      g.classList.add('sim-error');
    } else {
      // Kelas per status (mis. 'sim-status-RUN'); status tak dikenal → tanpa kelas status.
      const key = status == null ? '' : String(status).toUpperCase();
      if (SIM_CLASS_LIST.indexOf('sim-status-' + key) !== -1) {
        g.classList.add('sim-status-' + key);
      }
    }

    // Badge kecil di sudut kiri-atas node (di luar bentuk, konsisten semua tipe job).
    const hw = NODE_W / 2;
    const hh = NODE_H / 2;
    const badge = svg('g', {
      class: 'sim-badge',
      'data-sim-status': hasError ? 'ERROR' : String(result.status || ''),
      transform: 'translate(' + (-hw + 8) + ',' + (-hh - 2) + ')',
    });
    badge.appendChild(svg('circle', {
      class: 'sim-badge-bg',
      cx: 0, cy: 0, r: 8,
      fill: style.color,
      stroke: '#ffffff',
      'stroke-width': 1.5,
    }));
    const sym = svg('text', {
      class: 'sim-badge-symbol',
      x: 0, y: 0,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: '#ffffff',
      'font-size': 10,
      'font-weight': 'bold',
    });
    sym.textContent = style.symbol;
    badge.appendChild(sym);
    g.appendChild(badge);
  }

  /** Terapkan badge simulasi ke seluruh node job sesuai simResults saat ini. */
  function applyAllSimBadges() {
    nodeEls.forEach((g) => {
      const name = jobNameForNodeEl(g);
      if (name == null) {
        clearNodeSimBadge(g); // node non-job: pastikan bersih.
        return;
      }
      const result = simResultForJobName(name);
      if (result) {
        applyNodeSimBadge(g, result);
      } else {
        clearNodeSimBadge(g);
      }
    });
  }

  /**
   * setSimulationResults(map|null) — set/hapus hasil simulasi & badge node job (Task 16).
   * `map` = { <jobName>: JobSimResult }. `null` menghapus semua badge/kelas simulasi (Req 12.5).
   * Node non-job diabaikan. Idempoten: memanggil ulang menimpa badge sebelumnya.
   * @param {Object<string,Object>|null} map
   */
  function setSimulationResults(map) {
    if (map == null) {
      simResults = null;
      clearAllSimBadges();
      return;
    }
    // Salin dangkal agar referensi eksternal tak memengaruhi state internal.
    simResults = {};
    for (const key of Object.keys(map)) {
      simResults[key] = map[key];
    }
    applyAllSimBadges();
  }

  /**
   * getSimulationResultFor(nodeId) — JobSimResult untuk sebuah node graf (by nama job),
   * atau null bila bukan job / tak ada hasil.
   * @param {string} nodeId id node graf (mis. "job:build").
   * @returns {Object|null}
   */
  function getSimulationResultFor(nodeId) {
    if (nodeId == null) {
      return null;
    }
    const name = String(nodeId).indexOf('job:') === 0
      ? String(nodeId).slice('job:'.length)
      : String(nodeId);
    return simResultForJobName(name);
  }

  // ---- zoom & pan (Req 1.6/1.7) ----

  /** Terapkan transform translate+scale pada #viewport (Req 1.6/1.7). */
  function applyTransform() {
    if (viewportEl) {
      viewportEl.setAttribute(
        'transform',
        'translate(' + offset.x + ',' + offset.y + ') scale(' + scale + ')'
      );
    }
    // v2.0.0 #8 — jaga kotak viewport minimap tetap sinkron.
    try { updateMinimapViewport(); } catch (e) { /* minimap opsional */ }
  }

  /**
   * setZoom(scaleArg) — set zoom absolut, di-clamp 10%–400% (Req 1.6).
   * @param {number} scaleArg
   * @returns {number} scale efektif.
   */
  function setZoom(scaleArg) {
    scale = clampZoom(scaleArg);
    applyTransform();
    return scale;
  }

  /**
   * viewportSize() — ukuran viewport container dalam piksel. Bila 0 (mis. jsdom),
   * fallback ke dimensi konten atau default 800×600.
   * @returns {{width:number,height:number}}
   */
  function viewportSize() {
    const w = container && typeof container.clientWidth === 'number' ? container.clientWidth : 0;
    const h = container && typeof container.clientHeight === 'number' ? container.clientHeight : 0;
    if (w > 0 && h > 0) {
      return { width: w, height: h };
    }
    const fw = contentW > 0 ? contentW : 800;
    const fh = contentH > 0 ? contentH : 600;
    return { width: fw, height: fh };
  }

  /**
   * fitToView() — pas & pusatkan konten graf di viewport (Req 1.6/1.7).
   * @returns {{scale:number, offset:{x:number,y:number}}}
   */
  function fitToView() {
    const vp = viewportSize();
    const r = fitView({ width: contentW, height: contentH }, vp, 40);
    scale = r.scale;
    offset = r.offset;
    applyTransform();
    return { scale, offset };
  }

  /** Zoom target awal agar node langsung terbaca detail tanpa user zoom manual. */
  const INITIAL_MIN_SCALE = 1.0;

  /**
   * initialView() — pandang awal yang "zoom-in": bila hasil fit membuat node kecil,
   * naikkan skala ke INITIAL_MIN_SCALE agar node besar/detail, lalu posisikan ke
   * pojok kiri-atas graph (awal pipeline). Bila graph kecil & sudah muat, sama seperti fit.
   * @returns {{scale:number, offset:{x:number,y:number}}}
   */
  function initialView() {
    const vp = viewportSize();
    const fit = fitView({ width: contentW, height: contentH }, vp, 40);
    // Ambil skala yang lebih besar antara fit vs target minimum → node tampil detail.
    const targetScale = clampZoom(Math.max(fit.scale, INITIAL_MIN_SCALE));
    scale = targetScale;
    if (targetScale <= fit.scale + 1e-6) {
      // Graph muat penuh pada skala ini → pusatkan seperti fit biasa.
      offset = fit.offset;
    } else {
      // Ter-zoom melebihi fit → tampilkan mulai dari pojok kiri-atas graph dengan margin.
      const margin = 30;
      offset = { x: margin, y: margin };
    }
    applyTransform();
    return { scale, offset };
  }

  /**
   * zoomIn() — zoom masuk (faktor 1.2) berpusat di tengah viewport (Req 1.6).
   * @returns {number} scale efektif.
   */
  function zoomIn() {
    const vp = viewportSize();
    const r = zoomAtPoint({ scale, offset }, 1.2, { x: vp.width / 2, y: vp.height / 2 });
    scale = r.scale;
    offset = r.offset;
    applyTransform();
    return scale;
  }

  /**
   * zoomOut() — zoom keluar (faktor 1/1.2) berpusat di tengah viewport (Req 1.6).
   * @returns {number} scale efektif.
   */
  function zoomOut() {
    const vp = viewportSize();
    const r = zoomAtPoint({ scale, offset }, 1 / 1.2, { x: vp.width / 2, y: vp.height / 2 });
    scale = r.scale;
    offset = r.offset;
    applyTransform();
    return scale;
  }

  /**
   * resetView() — kembalikan pandang ke fit-to-view.
   * @returns {{scale:number, offset:{x:number,y:number}}}
   */
  function resetView() {
    return fitToView();
  }

  /**
   * zoomBy(factor) — zoom relatif (di-clamp) berpusat di tengah viewport (Req 1.6).
   * @param {number} factor
   * @returns {number} scale efektif.
   */
  function zoomBy(factor) {
    const f = typeof factor === 'number' && !Number.isNaN(factor) ? factor : 1;
    const vp = viewportSize();
    const r = zoomAtPoint({ scale, offset }, f, { x: vp.width / 2, y: vp.height / 2 });
    scale = r.scale;
    offset = r.offset;
    applyTransform();
    return scale;
  }

  /**
   * pan(dx, dy) — geser pandang secara aditif (Req 1.7).
   * @param {number} dx
   * @param {number} dy
   * @returns {{x:number,y:number}} offset baru.
   */
  function pan(dx, dy) {
    offset = applyPan(offset, { dx, dy });
    applyTransform();
    return { x: offset.x, y: offset.y };
  }

  /** Pasang listener wheel (zoom) & drag (pan) dengan guard aman jsdom. */
  function attachInteractionListeners() {
    if (!svgEl || typeof svgEl.addEventListener !== 'function') {
      return;
    }

    // Wheel → zoom halus, berpusat pada posisi kursor (zoom-to-cursor).
    svgEl.addEventListener('wheel', function (ev) {
      if (ev && typeof ev.preventDefault === 'function') {
        ev.preventDefault();
      }
      const delta = ev && typeof ev.deltaY === 'number' ? ev.deltaY : 0;
      const factor = delta < 0 ? 1.08 : (delta > 0 ? 1 / 1.08 : 1);

      // Titik kursor relatif container (piksel).
      const rectLeft = (container && typeof container.getBoundingClientRect === 'function')
        ? container.getBoundingClientRect().left : 0;
      const rectTop = (container && typeof container.getBoundingClientRect === 'function')
        ? container.getBoundingClientRect().top : 0;
      let px = (ev && typeof ev.offsetX === 'number')
        ? ev.offsetX
        : ((ev && typeof ev.clientX === 'number') ? ev.clientX - rectLeft : NaN);
      let py = (ev && typeof ev.offsetY === 'number')
        ? ev.offsetY
        : ((ev && typeof ev.clientY === 'number') ? ev.clientY - rectTop : NaN);

      // Guard: bila titik tak valid, pakai tengah viewport.
      const vp = viewportSize();
      if (typeof px !== 'number' || Number.isNaN(px)) {
        px = vp.width / 2;
      }
      if (typeof py !== 'number' || Number.isNaN(py)) {
        py = vp.height / 2;
      }

      const r = zoomAtPoint({ scale, offset }, factor, { x: px, y: py });
      scale = r.scale;
      offset = r.offset;
      applyTransform();
    });

    // Drag → pan.
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    svgEl.addEventListener('mousedown', function (ev) {
      dragging = true;
      lastX = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
      lastY = ev && typeof ev.clientY === 'number' ? ev.clientY : 0;
    });
    svgEl.addEventListener('mousemove', function (ev) {
      if (!dragging) {
        return;
      }
      const cx = ev && typeof ev.clientX === 'number' ? ev.clientX : lastX;
      const cy = ev && typeof ev.clientY === 'number' ? ev.clientY : lastY;
      pan(cx - lastX, cy - lastY);
      lastX = cx;
      lastY = cy;
    });
    const endDrag = function () { dragging = false; };
    svgEl.addEventListener('mouseup', endDrag);
    svgEl.addEventListener('mouseleave', endDrag);
  }

  // =========================================================================
  // TASK 11.5 — Legend
  // =========================================================================

  /**
   * renderLegend() — bangun elemen .graph-legend berisi keterangan warna/bentuk node per tipe,
   * gaya edge per tipe, serta penanda error & unresolved (Req 1.4, 1.5, 7.1, 7.5).
   * Ditambahkan ke container dan juga dikembalikan.
   * @returns {Element} elemen legend.
   */
  function renderLegend() {
    // Hapus legend lama bila ada agar idempoten.
    const old = container.querySelector('.graph-legend');
    if (old && old.parentNode) {
      old.parentNode.removeChild(old);
    }

    const legend = html('div', { class: 'graph-legend', role: 'group', 'aria-label': L('Legenda graf') });

    // --- bagian Node ---
    const nodeSection = html('div', { class: 'legend-section legend-nodes' });
    nodeSection.appendChild(html('div', { class: 'legend-title', text: 'Node' }));
    for (const type of NODE_TYPE_LIST) {
      const item = html('div', { class: 'legend-item legend-node-item', 'data-legend-node-type': type });
      const swatch = svg('svg', { class: 'legend-swatch', width: 22, height: 22, viewBox: '0 0 22 22' });
      const g = svg('g', { transform: 'translate(11,11)' });
      g.appendChild(buildLegendNodeShape(type));
      swatch.appendChild(g);
      // Penanda error pada swatch error_file (Req 7.1).
      if (type === NODE_TYPES.ERROR_FILE) {
        item.setAttribute('data-legend-error', 'true');
        const em = svg('circle', { class: 'error-marker', cx: 17, cy: 5, r: 4, fill: '#ffeb3b', stroke: '#c62828', 'stroke-width': 1 });
        swatch.appendChild(em);
      }
      item.appendChild(swatch);
      item.appendChild(html('span', { class: 'legend-label', text: type }));
      nodeSection.appendChild(item);
    }
    legend.appendChild(nodeSection);

    // --- bagian Edge ---
    const edgeSection = html('div', { class: 'legend-section legend-edges' });
    edgeSection.appendChild(html('div', { class: 'legend-title', text: L('Relasi (Edge)') }));
    for (const type of EDGE_TYPE_LIST) {
      edgeSection.appendChild(buildLegendEdgeItem(type, false));
    }
    // Penanda unresolved (Req 7.5).
    edgeSection.appendChild(buildLegendEdgeItem(EDGE_TYPES.NEEDS, true));
    legend.appendChild(edgeSection);

    container.appendChild(legend);
    return legend;
  }

  /** Bentuk swatch node kecil untuk legend. */
  function buildLegendNodeShape(type) {
    return buildNodeShape(type, 16, 12);
  }

  /** Item legend untuk sebuah edge (garis contoh + label). */
  function buildLegendEdgeItem(type, unresolved) {
    const style = styleForEdgeType(type, unresolved);
    const item = html('div', {
      class: 'legend-item legend-edge-item' + (unresolved ? ' unresolved' : ''),
      'data-legend-edge-type': type,
    });
    if (unresolved) {
      item.setAttribute('data-legend-unresolved', 'true');
    }
    const swatch = svg('svg', { class: 'legend-swatch', width: 30, height: 12, viewBox: '0 0 30 12' });
    const line = svg('line', {
      x1: 1, y1: 6, x2: 29, y2: 6,
      stroke: style.color,
      'stroke-width': style.width,
      'stroke-dasharray': style.dash || null,
    });
    swatch.appendChild(line);
    item.appendChild(swatch);
    const text = unresolved ? L('{0} (tak terselesaikan)', type) : type;
    item.appendChild(html('span', { class: 'legend-label', text: text }));
    return item;
  }

  // ---- Task #6: arah layout LR/TB ----
  function setLayoutDirection(dir) {
    layoutDir = (dir === 'TB') ? 'TB' : 'LR';
    if (currentModel) {
      currentLayout = layout(currentModel, { rankdir: layoutDir });
      buildSvg(currentModel, currentLayout);
    }
    return layoutDir;
  }
  function getLayoutDirection() { return layoutDir; }

  // ---- Task #4: persist posisi node ----
  function getNodePositions() {
    const out = {};
    if (currentLayout && currentLayout.positions) {
      for (const id of Object.keys(currentLayout.positions)) {
        const p = currentLayout.positions[id];
        out[id] = { x: p.x, y: p.y };
      }
    }
    return out;
  }
  function setNodePositions(pos) { savedPositions = pos || null; }

  // ---- focusJob: pilih + fit ke node tertentu ----
  function focusNode(nodeId) {
    if (!nodeId) return;
    try { selectNode(nodeId); } catch (e) {}
    try { fitToView(); } catch (e) {}
  }

  // ---- akses SVG untuk export (PNG/SVG di webview) ----
  function getSvgElement() { return svgEl; }
  function getContentSize() { return { width: contentW, height: contentH }; }

  // =========================================================================
  // v2.0.0 #8 — Minimap (overview panel untuk graf besar)
  // =========================================================================
  let minimapEl = null;      // container <div> minimap.
  let minimapSvg = null;     // <svg> mini.
  let minimapViewRect = null; // <rect> penanda area viewport.
  let minimapEnabled = false;
  let minimapDocHandlers = null; // { move, up } listener dokumen untuk drag (agar bisa dilepas).
  const MINIMAP_W = 180;
  const MINIMAP_H = 120;

  /** Bangun minimap dari layout terkini (node sebagai titik/kotak kecil ter-skala). */
  function buildMinimap() {
    if (!minimapEnabled || !currentModel || !currentLayout) { return; }
    // Bersihkan minimap lama.
    if (minimapEl && minimapEl.parentNode) { minimapEl.parentNode.removeChild(minimapEl); }
    minimapEl = html('div', { class: 'graph-minimap', 'data-minimap': 'true' });
    minimapSvg = svg('svg', {
      width: MINIMAP_W, height: MINIMAP_H,
      viewBox: '0 0 ' + (contentW || 1) + ' ' + (contentH || 1),
      preserveAspectRatio: 'xMidYMid meet',
      class: 'graph-minimap-svg',
    });
    // Node sebagai kotak kecil dengan warna tipe.
    for (const [id, vm] of nodeEntries(currentModel.nodes)) {
      const p = currentLayout.positions[id];
      if (!p) { continue; }
      const w = p.w || NODE_W;
      const h = p.h || NODE_H;
      minimapSvg.appendChild(svg('rect', {
        x: p.x - w / 2, y: p.y - h / 2, width: w, height: h,
        rx: 3, ry: 3,
        fill: colorForNodeType(vm && vm.type),
        opacity: 0.85,
      }));
    }
    // Kotak viewport (di-update oleh updateMinimapViewport).
    minimapViewRect = svg('rect', {
      class: 'graph-minimap-view',
      x: 0, y: 0, width: contentW || 1, height: contentH || 1,
      fill: 'rgba(255,255,255,0.12)', stroke: '#ffcc00', 'stroke-width': Math.max(2, (contentW || 800) / 200),
    });
    minimapSvg.appendChild(minimapViewRect);
    minimapEl.appendChild(minimapSvg);

    // Klik pada minimap → pusatkan viewport ke titik itu.
    // Interaksi minimap: klik untuk lompat + tahan-geser (drag) untuk pan mulus.
    attachMinimapInteractions();
    container.appendChild(minimapEl);
    updateMinimapViewport();
  }

  /** Lepas listener dokumen minimap yang lama (mencegah penumpukan saat rebuild). */
  function detachMinimapDocHandlers() {
    if (minimapDocHandlers && doc && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('mousemove', minimapDocHandlers.move);
      doc.removeEventListener('mouseup', minimapDocHandlers.up);
      doc.removeEventListener('mouseleave', minimapDocHandlers.up);
    }
    minimapDocHandlers = null;
  }

  /** Pasang drag pada minimap: mousedown+move+up (guard aman jsdom). */
  function attachMinimapInteractions() {
    if (!minimapSvg || typeof minimapSvg.addEventListener !== 'function') { return; }
    detachMinimapDocHandlers(); // bersihkan listener dari minimap sebelumnya.
    let dragging = false;

    minimapSvg.addEventListener('mousedown', function (ev) {
      if (ev && ev.button != null && ev.button !== 0) { return; } // hanya tombol kiri
      if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
      dragging = true;
      minimapSvg.style.cursor = 'grabbing';
      centerFromMinimapEvent(ev); // langsung lompat ke titik tekan
    });

    // Move & up dipasang di dokumen agar drag mulus walau kursor keluar minimap.
    const onMove = function (ev) {
      if (!dragging) { return; }
      centerFromMinimapEvent(ev);
    };
    const onUp = function () {
      if (!dragging) { return; }
      dragging = false;
      if (minimapSvg) { minimapSvg.style.cursor = 'grab'; }
    };
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('mousemove', onMove);
      doc.addEventListener('mouseup', onUp);
      doc.addEventListener('mouseleave', onUp);
      minimapDocHandlers = { move: onMove, up: onUp };
    }

    minimapSvg.style.cursor = 'grab';
  }

  /** Konversi posisi kursor pada minimap menjadi titik dunia lalu pusatkan viewport padanya. */
  function centerFromMinimapEvent(ev) {
    if (!minimapSvg || typeof minimapSvg.getBoundingClientRect !== 'function') { return; }
    const rect = minimapSvg.getBoundingClientRect();
    const rw = rect.width || MINIMAP_W;
    const rh = rect.height || MINIMAP_H;
    // Jepit posisi kursor ke area minimap agar drag di luar batas tak melempar viewport.
    let relX = ((ev && ev.clientX) || 0) - rect.left;
    let relY = ((ev && ev.clientY) || 0) - rect.top;
    relX = Math.max(0, Math.min(rw, relX));
    relY = Math.max(0, Math.min(rh, relY));
    // Perhitungkan preserveAspectRatio meet: skala seragam.
    const s = Math.min(rw / (contentW || 1), rh / (contentH || 1));
    const padX = (rw - (contentW || 1) * s) / 2;
    const padY = (rh - (contentH || 1) * s) / 2;
    const worldX = (relX - padX) / (s || 1);
    const worldY = (relY - padY) / (s || 1);
    const vp = viewportSize();
    offset = { x: vp.width / 2 - worldX * scale, y: vp.height / 2 - worldY * scale };
    applyTransform();
  }

  /** Update kotak viewport pada minimap agar mencerminkan area yang terlihat. */
  function updateMinimapViewport() {
    if (!minimapEnabled || !minimapViewRect) { return; }
    const vp = viewportSize();
    // Area dunia yang terlihat: dari transform saat ini (world = (screen - offset)/scale).
    const x = -offset.x / (scale || 1);
    const y = -offset.y / (scale || 1);
    const w = vp.width / (scale || 1);
    const h = vp.height / (scale || 1);
    minimapViewRect.setAttribute('x', x);
    minimapViewRect.setAttribute('y', y);
    minimapViewRect.setAttribute('width', Math.max(1, w));
    minimapViewRect.setAttribute('height', Math.max(1, h));
  }

  /** setMinimapEnabled(on) — aktif/nonaktifkan minimap. */
  function setMinimapEnabled(on) {
    minimapEnabled = !!on;
    if (minimapEnabled) {
      buildMinimap();
    } else if (minimapEl && minimapEl.parentNode) {
      detachMinimapDocHandlers();
      minimapEl.parentNode.removeChild(minimapEl);
      minimapEl = null; minimapSvg = null; minimapViewRect = null;
    }
    return minimapEnabled;
  }
  function isMinimapEnabled() { return minimapEnabled; }

  // ---- API publik ----
  return {
    render,
    renderMessage,
    showLoading,
    hideLoading,
    setVisibleEdgeTypes,
    selectNode,
    deselect,
    setZoom,
    zoomBy,
    pan,
    fitToView,
    zoomIn,
    zoomOut,
    resetView,
    renderLegend,
    // Task 16 — simulasi.
    setSimulationResults,
    getSimulationResultFor,
    // getter state (berguna untuk test/host).
    getSelectedId: function () { return selectedId; },
    getScale: function () { return scale; },
    getOffset: function () { return { x: offset.x, y: offset.y }; },
    getEnabledTypes: function () { return new Set(enabledTypes); },
    setLayoutDirection: setLayoutDirection,
    getLayoutDirection: getLayoutDirection,
    getNodePositions: getNodePositions,
    setNodePositions: setNodePositions,
    focusNode: focusNode,
    getSvgElement: getSvgElement,
    getContentSize: getContentSize,
    // v2.0.0 #8 — minimap.
    setMinimapEnabled: setMinimapEnabled,
    isMinimapEnabled: isMinimapEnabled,
  };
}

/**
 * computeNeighbors(deepGraph, nodeId) — hitung tetangga "behind" (masuk ke nodeId)
 * & "ahead" (keluar dari nodeId) dari sebuah graf mentah {nodes, edges}. Fungsi murni.
 *
 *  - behind : untuk tiap edge dengan target === nodeId, ambil node sumber (edge.source).
 *  - ahead  : untuk tiap edge dengan source === nodeId, ambil node tujuan (edge.target).
 *
 * Node yang tak ditemukan pada peta dilewati. Aman bila deepGraph null/tak lengkap.
 *
 * @param {{nodes?:Array<Object>, edges?:Array<Object>}|null} deepGraph
 * @param {string} nodeId
 * @returns {{behind:Array<Object>, ahead:Array<Object>}}
 */
function computeNeighbors(deepGraph, nodeId) {
  const behind = [];
  const ahead = [];
  if (!deepGraph) {
    return { behind, ahead };
  }

  const nodes = {};
  const nodeList = Array.isArray(deepGraph.nodes) ? deepGraph.nodes : [];
  for (const n of nodeList) {
    if (n && n.id != null) {
      nodes[n.id] = n;
    }
  }

  const edges = Array.isArray(deepGraph.edges) ? deepGraph.edges : [];

  function pick(node, edgeType) {
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      path: node.path,
      line_number: node.line_number,
      edgeType: edgeType,
    };
  }

  for (const edge of edges) {
    if (!edge) {
      continue;
    }
    if (edge.target === nodeId) {
      const src = nodes[edge.source];
      if (src) {
        behind.push(pick(src, edge.type));
      }
    }
    if (edge.source === nodeId) {
      const tgt = nodes[edge.target];
      if (tgt) {
        ahead.push(pick(tgt, edge.type));
      }
    }
  }

  return { behind, ahead };
}

module.exports = {
  createGraphView,
  computeNeighbors,
  colorForNodeType,
  styleForEdgeType,
  statusBadgeStyle,
  // konstanta diekspor untuk pengujian & pemakaian ulang.
  NODE_COLORS,
  NODE_SHAPES,
  EDGE_STYLES,
  UNRESOLVED_STYLE,
  SIM_STATUS_STYLES,
  SIM_ERROR_STYLE,
  SVG_NS,
};
