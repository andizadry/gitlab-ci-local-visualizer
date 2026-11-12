/**
 * edgeFilter.js — Logika murni EdgeFilterBar untuk Dependency Graph Visualizer.
 *
 * Modul logika murni webview (vanilla JS, CommonJS, tanpa dependency runtime eksternal,
 * tanpa akses DOM). File ini di-inline ke `webview.html` saat build agar patuh CSP &
 * 100% offline (Req 8), dan di-`require` langsung oleh test headless serta GraphView.
 *
 * Tanggung jawab:
 *  - Menurunkan tepat 6 kontrol filter (satu per tipe Edge) dari render model,
 *    dengan interaktivitas bergantung keberadaan edge tipe tsb (Req 2.1, 2.7).
 *  - Menetapkan state awal semua tipe aktif (Req 2.6).
 *  - Menghitung himpunan edge yang terlihat sesuai tipe yang aktif (Req 2.2, 2.3, 6.3, 6.4).
 *  - Meng-toggle sebuah tipe secara round-trip tanpa memutasi input (Req 2.3, 6.4).
 *
 * Requirements terkait: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 6.3, 6.4.
 */

'use strict';

const { EDGE_TYPE_LIST } = require('./types');

/**
 * @typedef {Object} EdgeFilterControl
 * @property {string} type          Salah satu tipe pada EDGE_TYPE_LIST.
 * @property {number} count         Jumlah edge bertipe ini pada render model.
 * @property {boolean} enabled      true bila tipe sedang ditampilkan (default true, Req 2.6).
 * @property {boolean} interactive  true jika dan hanya jika count > 0 (Req 2.1, 2.7);
 *                                   tipe tanpa edge tetap muncul namun non-interaktif/disabled.
 */

/**
 * Ambil jumlah edge per tipe dari render model dengan aman.
 * Toleran terhadap model tanpa edgeTypeCounts atau nilai non-angka.
 *
 * @param {{edgeTypeCounts?: Object<string, number>}} [model]
 * @param {string} type
 * @returns {number} jumlah edge (>= 0)
 */
function countFor(model, type) {
  const counts = model && model.edgeTypeCounts;
  if (!counts || typeof counts !== 'object') {
    return 0;
  }
  const raw = counts[type];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  // Normalisasi ke bilangan bulat non-negatif.
  return Math.floor(n);
}

/**
 * Turunkan tepat 6 kontrol Edge_Type_Filter dari render model, dalam urutan stabil
 * sesuai EDGE_TYPE_LIST (Req 2.1). Sebuah kontrol bersifat interaktif jika dan hanya jika
 * ada >= 1 edge bertipe tersebut; tipe tanpa edge tetap muncul namun non-interaktif
 * (disabled) (Req 2.7). Secara default seluruh kontrol dalam keadaan aktif (Req 2.6).
 *
 * @param {{edgeTypeCounts?: Object<string, number>}} [model] render model hasil GraphModelBuilder.build().
 * @returns {EdgeFilterControl[]} tepat 6 kontrol, urut sesuai EDGE_TYPE_LIST.
 */
function deriveFilters(model) {
  return EDGE_TYPE_LIST.map((type) => {
    const count = countFor(model, type);
    return {
      type,
      count,
      enabled: true, // Req 2.6: semua aktif saat pertama render.
      interactive: count > 0, // Req 2.1/2.7: interaktif iff ada >= 1 edge tipe tsb.
    };
  });
}

/**
 * Himpunan tipe yang aktif saat render pertama: seluruh 6 tipe (Req 2.6).
 *
 * @returns {Set<string>} Set berisi semua tipe pada EDGE_TYPE_LIST.
 */
function initialEnabledTypes() {
  return new Set(EDGE_TYPE_LIST);
}

/**
 * Ubah enabledTypes (Set atau array) menjadi Set untuk pemeriksaan keanggotaan.
 * Tidak memutasi input.
 *
 * @param {Set<string>|string[]|null|undefined} enabledTypes
 * @returns {Set<string>}
 */
function asSet(enabledTypes) {
  if (enabledTypes instanceof Set) {
    return enabledTypes;
  }
  if (Array.isArray(enabledTypes)) {
    return new Set(enabledTypes);
  }
  return new Set();
}

/**
 * Kembalikan hanya edge yang tipenya termasuk himpunan tipe aktif (Req 2.2, 2.3, 6.3, 6.4).
 * Edge bertipe nonaktif disembunyikan; edge bertipe lain tetap tampil. Node TIDAK
 * dipengaruhi oleh fungsi ini (Node selalu tampil — Req 2.4 ditangani di layer render).
 *
 * @param {Array<{type: string}>} edges          daftar edge (mis. model.edges).
 * @param {Set<string>|string[]} enabledTypes     himpunan tipe yang sedang aktif.
 * @returns {Array<{type: string}>} subset edge yang terlihat (array baru; input tak dimutasi).
 */
function visibleEdges(edges, enabledTypes) {
  if (!Array.isArray(edges)) {
    return [];
  }
  const enabled = asSet(enabledTypes);
  return edges.filter((edge) => edge && enabled.has(edge.type));
}

/**
 * Toggle sebuah tipe pada himpunan tipe aktif dan kembalikan Set BARU (Req 2.3, 6.4).
 * Jika tipe sudah aktif → dihapus (off); jika tidak → ditambah (on). Mendukung round-trip:
 * toggle dua kali mengembalikan himpunan ke keadaan semula. Input tidak dimutasi.
 *
 * @param {Set<string>|string[]} enabledTypes  himpunan tipe aktif saat ini.
 * @param {string} type                        tipe yang di-toggle.
 * @returns {Set<string>} Set baru hasil toggle.
 */
function toggleType(enabledTypes, type) {
  const next = new Set(asSet(enabledTypes)); // salinan; input tak dimutasi.
  if (next.has(type)) {
    next.delete(type);
  } else {
    next.add(type);
  }
  return next;
}

module.exports = {
  deriveFilters,
  initialEnabledTypes,
  visibleEdges,
  toggleType,
};
