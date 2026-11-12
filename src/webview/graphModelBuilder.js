/**
 * graphModelBuilder.js — GraphModelBuilder untuk Dependency Graph Visualizer.
 *
 * Fungsi logika murni (vanilla JS, CommonJS, tanpa dependency runtime eksternal) yang
 * mengubah `deep_graph` (keluaran `ci_preview.py get_deep_graph()`) menjadi *render model*
 * internal webview: memvalidasi input, mengindeks node by id, membuang edge dangling,
 * menandai node error & relasi needs tak terselesaikan, serta menghitung jumlah edge per tipe.
 *
 * File ini di-inline ke `webview.html` saat build (patuh CSP & 100% offline, Req 8) dan
 * di-`require` langsung oleh test headless serta modul lain (LayoutEngine, GraphView, dll.).
 *
 * Requirements terkait:
 *  - 1.1/1.2/1.3 — render mempertahankan node (id/label/type) & edge valid (arah source→target).
 *  - 1.8 — graf kosong (valid namun tanpa node).
 *  - 1.9 — input invalid (bukan {nodes,edges} atau nodes/edges bukan array).
 *  - 1.10 — edge dangling (endpoint bukan id node) dibuang.
 *  - 6.6 — batas over-limit (|nodes| > MAX_NODES).
 *  - 7.1 — node error_file bertanda (hasErrorMarker).
 *  - 7.5 — relasi needs tak terselesaikan ditandai (unresolved).
 */

'use strict';

const {
  NODE_TYPES,
  EDGE_TYPES,
  EDGE_TYPE_LIST,
  MAX_NODES,
} = require('./types');

/**
 * Buat objek edgeTypeCounts dengan semua tipe pada EDGE_TYPE_LIST diinisialisasi ke 0.
 * @returns {Object<string, number>}
 */
function emptyEdgeTypeCounts() {
  const counts = {};
  for (const type of EDGE_TYPE_LIST) {
    counts[type] = 0;
  }
  return counts;
}

/**
 * Hasil "gagal" standar bila input tidak dapat diproses sebagai {nodes, edges} (Req 1.9).
 * @returns {import('./types').BuildResult}
 */
function invalidResult() {
  return {
    ok: false,
    empty: false,
    overLimit: false,
    nodes: {},
    edges: [],
    edgeTypeCounts: emptyEdgeTypeCounts(),
  };
}

/**
 * Petakan `node.line_number` ke `line` bila berupa bilangan bulat positif; selain itu undefined.
 * @param {*} value
 * @returns {number|undefined}
 */
function toValidLine(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

/**
 * Bangun NodeVM dari sebuah node deep_graph mentah.
 * Field opsional (path, line, status) hanya disertakan bila tersedia/valid.
 * @param {Object} node
 * @returns {import('./types').NodeVM}
 */
function toNodeVM(node) {
  const vm = {
    id: node.id,
    label: node.label,
    type: node.type,
  };

  if (node.path !== undefined && node.path !== null) {
    vm.path = node.path;
  }

  const line = toValidLine(node.line_number);
  if (line !== undefined) {
    vm.line = line;
  }

  if (node.status !== undefined && node.status !== null) {
    vm.status = node.status;
  }

  vm.hasErrorMarker = node.type === NODE_TYPES.ERROR_FILE;

  return vm;
}

/**
 * GraphModelBuilder.build — ubah deep_graph menjadi render model tervalidasi.
 *
 * @param {*} deepGraph Objek `{ nodes: Array, edges: Array }` dari get_deep_graph().
 * @returns {import('./types').BuildResult}
 */
function build(deepGraph) {
  // Req 1.9 — validasi bentuk input.
  if (
    deepGraph === null ||
    typeof deepGraph !== 'object' ||
    !Array.isArray(deepGraph.nodes) ||
    !Array.isArray(deepGraph.edges)
  ) {
    return invalidResult();
  }

  const rawNodes = deepGraph.nodes;
  const rawEdges = deepGraph.edges;

  // Req 1.8 — graf kosong (valid namun tanpa node).
  if (rawNodes.length === 0) {
    return {
      ok: true,
      empty: true,
      overLimit: false,
      nodes: {},
      edges: [],
      edgeTypeCounts: emptyEdgeTypeCounts(),
    };
  }

  // Req 6.6 — over-limit bila jumlah node melebihi MAX_NODES.
  const overLimit = rawNodes.length > MAX_NODES;

  // Indeks node by id → NodeVM (Req 1.1/1.2/1.3).
  const nodes = {};
  for (const node of rawNodes) {
    if (node && node.id !== undefined && node.id !== null) {
      nodes[node.id] = toNodeVM(node);
    }
  }

  // Set id node untuk cek keberadaan endpoint edge.
  const nodeIds = new Set(Object.keys(nodes));

  const edges = [];
  const edgeTypeCounts = emptyEdgeTypeCounts();

  for (const edge of rawEdges) {
    if (!edge) {
      continue;
    }
    const { source, target, type } = edge;
    const hasSource = nodeIds.has(source);
    const hasTarget = nodeIds.has(target);

    // Req 7.5 — needs dengan target tak ada node: JANGAN buang, tandai unresolved.
    // Syaratnya source tetap ada (edge harus berakar pada node yang dirender).
    const isUnresolvedNeeds =
      type === EDGE_TYPES.NEEDS && hasSource && !hasTarget;

    if (!isUnresolvedNeeds && (!hasSource || !hasTarget)) {
      // Req 1.10 — edge dangling (endpoint bukan id node) dibuang.
      continue;
    }

    const edgeVM = {
      id: `${type}:${source}->${target}`,
      source,
      target,
      type,
      label: edge.label,
      unresolved: isUnresolvedNeeds,
    };

    edges.push(edgeVM);

    // edgeTypeCounts dihitung dari edge hasil akhir yang disertakan.
    if (Object.prototype.hasOwnProperty.call(edgeTypeCounts, type)) {
      edgeTypeCounts[type] += 1;
    }
  }

  return {
    ok: true,
    empty: false,
    overLimit,
    nodes,
    edges,
    edgeTypeCounts,
  };
}

module.exports = {
  build,
  // helper diekspor untuk digunakan ulang & pengujian.
  emptyEdgeTypeCounts,
  toNodeVM,
};
