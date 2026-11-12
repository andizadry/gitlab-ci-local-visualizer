/**
 * highlight.js — Logika murni penyorotan (HighlightController) untuk Dependency Graph Visualizer.
 *
 * Modul logika murni webview (vanilla JS, CommonJS, tanpa dependency runtime eksternal).
 * File ini di-inline ke `webview.html` saat build agar patuh CSP & 100% offline (Req 8),
 * dan di-`require` langsung oleh test headless serta GraphView (yang menerjemahkan hasil
 * ke keadaan visual SVG: tersorot vs diredupkan).
 *
 * TIDAK menyentuh DOM. Fungsi murni: hasil hanya bergantung pada argumen, tidak pada
 * seleksi/riwayat sebelumnya (Req 5.6).
 *
 * Kontrak (Keputusan 3, Properties 9–11):
 *   computeHighlight(selectedId, allNodeIds, visibleEdges) -> HighlightState
 *   clearHighlight() -> HighlightState (baseline: semua normal)
 *
 * Tetangga (Related_Node) dihitung 1-hop pada `visibleEdges` — yaitu edge yang SEDANG
 * terlihat setelah filter tipe edge (EdgeFilterBar). Jika sebuah edge menyentuh selectedId
 * (source === selectedId atau target === selectedId), endpoint lawannya adalah tetangga.
 *
 * Requirements terkait:
 *  - 5.1 — node terpilih tersorot.
 *  - 5.2 — seluruh Related_Node (tetangga 1-hop) tersorot.
 *  - 5.3 — seluruh edge terlihat yang menyentuh node terpilih tersorot.
 *  - 5.4 — node & edge lain diredupkan (partisi dari tersorot).
 *  - 5.5 — deselect → baseline (semua normal).
 *  - 5.6 — hasil murni, tak bergantung seleksi sebelumnya.
 *  - 5.7 — node tanpa tetangga: hanya node terpilih tersorot, sisanya diredupkan.
 */

'use strict';

/**
 * HighlightState — hasil computeHighlight / clearHighlight.
 *
 * highlightedNodes ∪ dimmedNodes = allNodeIds, dan keduanya saling lepas (partisi) (Req 5.4).
 * highlightedEdges berisi INDEKS edge pada array `visibleEdges`; dimmedEdges berisi
 * indeks visible edge sisanya. Keduanya juga partisi dari indeks visibleEdges.
 *
 * @typedef {Object} HighlightState
 * @property {string|null} selectedId        Id node terpilih; `null` saat baseline (tidak ada seleksi).
 * @property {Set<string>} highlightedNodes  {selectedId} ∪ tetangga 1-hop pada visibleEdges (Req 5.1, 5.2).
 * @property {number[]}    highlightedEdges  Indeks visibleEdges yang salah satu endpoint-nya === selectedId (Req 5.3).
 * @property {Set<string>} dimmedNodes       allNodeIds \ highlightedNodes (Req 5.4).
 * @property {number[]}    dimmedEdges       Indeks visibleEdges yang tidak tersorot (Req 5.4).
 */

/**
 * Normalisasi `allNodeIds` (array atau Set) menjadi array id yang stabil & terdeduplikasi.
 * @param {Iterable<string>} allNodeIds
 * @returns {string[]}
 */
function toNodeIdArray(allNodeIds) {
  if (allNodeIds instanceof Set) {
    return Array.from(allNodeIds);
  }
  if (Array.isArray(allNodeIds)) {
    // Deduplikasi menjaga partisi tetap benar bila caller memberi id ganda.
    return Array.from(new Set(allNodeIds));
  }
  if (allNodeIds && typeof allNodeIds[Symbol.iterator] === 'function') {
    return Array.from(new Set(allNodeIds));
  }
  return [];
}

/**
 * Keadaan baseline: tidak ada seleksi, semua node/edge normal (tidak tersorot & tidak diredupkan).
 * Dipakai saat pengguna membatalkan pemilihan node (Req 5.5) dan sebagai state awal.
 *
 * @returns {HighlightState}
 */
function clearHighlight() {
  return {
    selectedId: null,
    highlightedNodes: new Set(),
    highlightedEdges: [],
    dimmedNodes: new Set(),
    dimmedEdges: [],
  };
}

/**
 * Hitung himpunan sorotan/redup untuk sebuah node terpilih.
 *
 * Murni: hasil hanya bergantung pada (selectedId, allNodeIds, visibleEdges) (Req 5.6).
 *
 * Aturan:
 *  - highlightedNodes = {selectedId} ∪ tetangga 1-hop pada visibleEdges (Req 5.1, 5.2).
 *    Tetangga: untuk tiap edge terlihat, jika edge.source === selectedId → target tetangga;
 *    jika edge.target === selectedId → source tetangga. Hanya tetangga yang juga ada pada
 *    allNodeIds yang dimasukkan ke highlightedNodes (menjaga partisi terhadap allNodeIds).
 *  - highlightedEdges = indeks visibleEdges yang salah satu endpoint-nya === selectedId (Req 5.3).
 *  - dimmedNodes = allNodeIds \ highlightedNodes; dimmedEdges = indeks visible edge sisanya (Req 5.4).
 *  - Node tanpa tetangga → highlightedNodes = {selectedId}, sisanya diredupkan (Req 5.7).
 *
 * Jika selectedId falsy (null/undefined/''), kembalikan baseline (setara clearHighlight).
 *
 * @param {string} selectedId              Id node yang dipilih.
 * @param {Iterable<string>} allNodeIds    Semua id node yang dirender (array atau Set).
 * @param {Array<{source: string, target: string}>} visibleEdges  Edge yang sedang terlihat (setelah filter).
 * @returns {HighlightState}
 */
function computeHighlight(selectedId, allNodeIds, visibleEdges) {
  const nodeIds = toNodeIdArray(allNodeIds);

  // Tanpa seleksi → baseline (Req 5.5/5.6). Tetap kembalikan struktur konsisten.
  if (selectedId == null || selectedId === '') {
    return clearHighlight();
  }

  const allSet = new Set(nodeIds);
  const edges = Array.isArray(visibleEdges) ? visibleEdges : [];

  // Himpunan tersorot dimulai dari node terpilih (Req 5.1).
  const highlightedNodes = new Set([selectedId]);
  const highlightedEdges = [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (!edge) {
      continue;
    }
    const touchesSelected =
      edge.source === selectedId || edge.target === selectedId;
    if (!touchesSelected) {
      continue;
    }

    // Edge yang menyentuh node terpilih ikut tersorot (Req 5.3).
    highlightedEdges.push(i);

    // Endpoint lawan = tetangga 1-hop (Req 5.2). Sertakan hanya bila ada pada allNodeIds
    // agar highlightedNodes tetap subset allNodeIds (menjaga partisi Req 5.4).
    const neighbor = edge.source === selectedId ? edge.target : edge.source;
    if (allSet.has(neighbor)) {
      highlightedNodes.add(neighbor);
    }
  }

  // dimmedNodes = allNodeIds \ highlightedNodes (partisi, Req 5.4/5.7).
  const dimmedNodes = new Set();
  for (const id of nodeIds) {
    if (!highlightedNodes.has(id)) {
      dimmedNodes.add(id);
    }
  }

  // dimmedEdges = indeks visible edge yang tidak tersorot (partisi indeks visibleEdges).
  const highlightedEdgeSet = new Set(highlightedEdges);
  const dimmedEdges = [];
  for (let i = 0; i < edges.length; i++) {
    if (!highlightedEdgeSet.has(i)) {
      dimmedEdges.push(i);
    }
  }

  return {
    selectedId,
    highlightedNodes,
    highlightedEdges,
    dimmedNodes,
    dimmedEdges,
  };
}

module.exports = {
  computeHighlight,
  clearHighlight,
};
