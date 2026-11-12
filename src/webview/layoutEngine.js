/**
 * layoutEngine.js — LayoutEngine, pembungkus tipis di atas `dagre` untuk Dependency Graph Visualizer.
 *
 * Menerima *render model* (hasil GraphModelBuilder.build) dan menghitung koordinat pusat
 * tiap node beserta ukuran box, serta titik-titik (points) tiap edge, menggunakan layout
 * layered (Sugiyama) dari `dagre` (Keputusan 2, Req 6.2).
 *
 * Pemuatan `dagre` (dual-mode):
 *  - Saat di-inline ke `webview.html` (build), `dagre` tersedia sebagai global `dagre`
 *    (di-embed via placeholder `__DAGRE_LIB__`). Modul memakai global tersebut.
 *  - Saat test headless (Node/vitest), `dagre` di-`require` dari `node_modules`.
 * `getDagre()` menyelesaikan kedua kasus secara transparan.
 *
 * File ini adalah logika murni webview (vanilla JS, CommonJS, tanpa DOM), sehingga aman
 * di-inline (patuh CSP & 100% offline, Req 8) dan di-`require` langsung oleh test.
 *
 * Requirements terkait:
 *  - 6.2 — layout DAG: jarak antar node ≥ 20px & tidak ada dua node dengan pusat berhimpit.
 */

'use strict';

/**
 * Opsi layout default. `nodesep` & `ranksep` ≥ 20px untuk menjamin gap tepi-ke-tepi
 * minimum pada zoom default (Req 6.2).
 * @type {{nodesep:number, ranksep:number, rankdir:string, nodeWidth:number, nodeHeight:number, marginx:number, marginy:number}}
 */
const DEFAULT_OPTS = {
  nodesep: 30,
  ranksep: 40,
  rankdir: 'LR',
  nodeWidth: 160,
  nodeHeight: 40,
  marginx: 20,
  marginy: 20,
};

/**
 * Selesaikan instance `dagre` yang akan dipakai.
 * (1) Jika global `dagre` tersedia (kasus inline di webview) → pakai itu.
 * (2) Selain itu coba `require('dagre')` (kasus test headless / Node).
 *
 * @returns {*} Instance `dagre` (mengekspos `graphlib` & `layout`).
 * @throws {Error} bila `dagre` tak dapat diselesaikan pada kedua mode.
 */
function getDagre() {
  // Kasus (1): global `dagre` (di-inline via __DAGRE_LIB__ pada webview.html).
  if (typeof dagre !== 'undefined' && dagre) {
    return dagre;
  }

  // Kasus (2): require dari node_modules (test headless / Node).
  if (typeof require === 'function') {
    try {
      // eslint-disable-next-line global-require
      const mod = require('dagre');
      if (mod) {
        return mod;
      }
    } catch (err) {
      throw new Error('LayoutEngine: dagre tidak tersedia (global maupun require): ' + err.message);
    }
  }

  throw new Error('LayoutEngine: dagre tidak tersedia (tidak ada global `dagre` maupun `require`).');
}

/**
 * Ambil iterable [id, NodeVM] dari `model.nodes` yang berupa Map atau object literal by id.
 * @param {Map<string, Object>|Object<string, Object>} nodes
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

/**
 * Cek keberadaan id node pada `model.nodes` (Map atau object literal).
 * @param {Map<string, Object>|Object<string, Object>} nodes
 * @param {string} id
 * @returns {boolean}
 */
function hasNode(nodes, id) {
  if (nodes instanceof Map) {
    return nodes.has(id);
  }
  if (nodes && typeof nodes === 'object') {
    return Object.prototype.hasOwnProperty.call(nodes, id);
  }
  return false;
}

/**
 * LayoutEngine.layout — hitung posisi node & titik edge memakai `dagre`.
 *
 * @param {import('./types').BuildResult} model Render model (punya `nodes` by id & `edges` array).
 * @param {Partial<typeof DEFAULT_OPTS>} [opts] Opsi layout (nodesep/ranksep/rankdir/nodeWidth/nodeHeight).
 * @returns {{
 *   positions: Object<string, {x:number, y:number, w:number, h:number}>,
 *   edges: Array<{source:string, target:string, points: Array<{x:number, y:number}>}>,
 *   width: number,
 *   height: number
 * }}
 */
function layout(model, opts) {
  const dagreLib = getDagre();

  const o = Object.assign({}, DEFAULT_OPTS, opts || {});
  // Req 6.2 — jaga nodesep/ranksep tidak turun di bawah 20px meski pemanggil menurunkannya.
  const nodesep = Math.max(20, Number(o.nodesep) || DEFAULT_OPTS.nodesep);
  const ranksep = Math.max(20, Number(o.ranksep) || DEFAULT_OPTS.ranksep);
  const nodeWidth = Number(o.nodeWidth) || DEFAULT_OPTS.nodeWidth;
  const nodeHeight = Number(o.nodeHeight) || DEFAULT_OPTS.nodeHeight;

  const nodes = (model && model.nodes) || {};
  const edges = (model && Array.isArray(model.edges)) ? model.edges : [];

  const g = new dagreLib.graphlib.Graph({ directed: true });
  g.setGraph({
    rankdir: o.rankdir,
    nodesep,
    ranksep,
    marginx: o.marginx,
    marginy: o.marginy,
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Daftarkan tiap node dengan bounding box tetap + label.
  const entries = nodeEntries(nodes);
  for (const [id, vm] of entries) {
    g.setNode(id, {
      width: nodeWidth,
      height: nodeHeight,
      label: (vm && vm.label) != null ? vm.label : id,
    });
  }

  // Daftarkan edge hanya bila KEDUA endpoint ada sebagai node (aman: hindari node implisit).
  for (const edge of edges) {
    if (!edge) {
      continue;
    }
    const { source, target } = edge;
    if (hasNode(nodes, source) && hasNode(nodes, target)) {
      g.setEdge(source, target);
    }
  }

  dagreLib.layout(g);

  // Bangun positions: dagre memberi x,y sebagai PUSAT node; sertakan w,h.
  const positions = {};
  for (const [id] of entries) {
    const n = g.node(id);
    if (n) {
      positions[id] = {
        x: n.x,
        y: n.y,
        w: n.width,
        h: n.height,
      };
    }
  }

  // Verifikasi pasca-layout (Req 6.2): pusat identik → pemisahan deterministik kecil.
  // Iterasi dalam urutan id stabil agar hasil deterministik.
  const seen = new Map(); // "x,y" -> jumlah node yang sudah menempati pusat itu
  const idsInOrder = entries.map(([id]) => id).filter((id) => positions[id]);
  for (let i = 0; i < idsInOrder.length; i += 1) {
    const id = idsInOrder[i];
    const p = positions[id];
    let key = p.x + ',' + p.y;
    if (seen.has(key)) {
      // Sudah ada node lain pada pusat yang sama → geser deterministik kecil.
      const collisions = seen.get(key);
      p.x += collisions; // offset i*1px berbasis jumlah tabrakan pada pusat tsb.
      p.y += collisions;
      seen.set(key, collisions + 1);
      // Catat pula pusat baru agar tidak bertabrakan dengan node lain berikutnya.
      const newKey = p.x + ',' + p.y;
      if (!seen.has(newKey)) {
        seen.set(newKey, 1);
      } else {
        // Pusat baru pun sudah terpakai: dorong terus hingga unik.
        let extra = seen.get(newKey);
        while (seen.has(p.x + ',' + p.y)) {
          p.x += extra;
          p.y += extra;
          extra += 1;
        }
        seen.set(p.x + ',' + p.y, 1);
      }
    } else {
      seen.set(key, 1);
    }
  }

  // Bangun titik edge dari g.edge(source, target).
  const outEdges = [];
  for (const edge of edges) {
    if (!edge) {
      continue;
    }
    const { source, target } = edge;
    if (!(hasNode(nodes, source) && hasNode(nodes, target))) {
      continue;
    }
    const e = g.edge(source, target);
    const points = (e && Array.isArray(e.points))
      ? e.points.map((pt) => ({ x: pt.x, y: pt.y }))
      : [];
    outEdges.push({ source, target, points });
  }

  const graphMeta = g.graph() || {};

  return {
    positions,
    edges: outEdges,
    width: graphMeta.width,
    height: graphMeta.height,
  };
}

module.exports = {
  layout,
  getDagre,
  DEFAULT_OPTS,
};
