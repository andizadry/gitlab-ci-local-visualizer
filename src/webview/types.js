/**
 * types.js — Kontrak render model & konstanta tipe untuk Dependency Graph Visualizer.
 *
 * Modul logika murni webview (vanilla JS, CommonJS, tanpa dependency runtime eksternal).
 * File ini di-inline ke `webview.html` saat build agar patuh CSP & 100% offline (Req 8),
 * dan di-`require` langsung oleh test headless (vitest) serta modul lain
 * (GraphModelBuilder, EdgeFilterBar, InteractionController, dll.).
 *
 * Requirements terkait: 1.4 (keterbedaan visual node per tipe),
 * 1.5 (keterbedaan visual edge per tipe), 2.1 (tepat 6 Edge_Type_Filter),
 * 6.6 (batas over-limit), 1.6 (rentang zoom 10%–400%).
 */

'use strict';

/**
 * Semua tipe Node yang tersedia pada Deep_Graph.
 * Dipakai untuk penampilan visual berbeda & konsisten per tipe (Req 1.4).
 * @readonly
 * @enum {string}
 */
const NODE_TYPES = {
  ROOT_FILE: 'root_file',
  INCLUDE_FILE: 'include_file',
  ERROR_FILE: 'error_file',
  TEMPLATE: 'template',
  JOB: 'job',
  STAGE: 'stage',
  // Pipeline downstream (parent-child / multi-project) dan child dinamis (artifact, runtime).
  CHILD_PIPELINE: 'child_pipeline',
  DYNAMIC_CHILD: 'dynamic_child',
};

/**
 * Daftar semua nilai tipe Node (urutan stabil).
 * @type {string[]}
 */
const NODE_TYPE_LIST = [
  NODE_TYPES.ROOT_FILE,
  NODE_TYPES.INCLUDE_FILE,
  NODE_TYPES.ERROR_FILE,
  NODE_TYPES.TEMPLATE,
  NODE_TYPES.JOB,
  NODE_TYPES.STAGE,
  NODE_TYPES.CHILD_PIPELINE,
  NODE_TYPES.DYNAMIC_CHILD,
];

/**
 * Semua tipe Edge (relasi berarah) yang tersedia pada Deep_Graph.
 * Dipakai untuk penampilan visual berbeda & konsisten per tipe (Req 1.5).
 * @readonly
 * @enum {string}
 */
const EDGE_TYPES = {
  INCLUDES: 'includes',
  DEFINES_TEMPLATE: 'defines_template',
  DEFINES_JOB: 'defines_job',
  EXTENDS: 'extends',
  NEEDS: 'needs',
  STAGE_CONTAINS: 'stage_contains',
  // bridge job -> pipeline downstream, dan pipeline downstream -> job di dalamnya.
  TRIGGERS: 'triggers',
  CHILD_CONTAINS: 'child_contains',
};

/**
 * Daftar tipe Edge dengan urutan stabil (6 tipe awal + 2 tipe downstream).
 * Urutan ini dipakai EdgeFilterBar untuk menampilkan satu kontrol filter per tipe (Req 2.1)
 * dalam urutan yang konsisten.
 * @type {string[]}
 */
const EDGE_TYPE_LIST = [
  EDGE_TYPES.INCLUDES,
  EDGE_TYPES.DEFINES_TEMPLATE,
  EDGE_TYPES.DEFINES_JOB,
  EDGE_TYPES.EXTENDS,
  EDGE_TYPES.NEEDS,
  EDGE_TYPES.STAGE_CONTAINS,
  EDGE_TYPES.TRIGGERS,
  EDGE_TYPES.CHILD_CONTAINS,
];

/**
 * Batas maksimum jumlah Node yang dapat dirender. Jika |nodes| melebihi nilai ini,
 * build() menandai hasil sebagai over-limit dan rendering dihentikan (Req 6.6).
 * @type {number}
 */
const MAX_NODES = 1000;

/**
 * Batas minimum tingkat zoom (10%) untuk clamp InteractionController (Req 1.6).
 * @type {number}
 */
const ZOOM_MIN = 0.10;

/**
 * Batas maksimum tingkat zoom (400%) untuk clamp InteractionController (Req 1.6).
 * @type {number}
 */
const ZOOM_MAX = 4.00;

/**
 * NodeVM — view model sebuah Node dalam render model internal webview.
 * Dihasilkan GraphModelBuilder dari `deep_graph.nodes` (line_number → line).
 *
 * @typedef {Object} NodeVM
 * @property {string} id            Identitas unik node (mis. "job:build_app"). Digunakan sebagai key pada map nodes.
 * @property {string} label         Teks label yang ditampilkan pada node (Req 1.3).
 * @property {string} type          Salah satu dari NODE_TYPE_LIST (Req 1.4).
 * @property {string} [path]        Lokasi file sumber; ada pada node file/job/template. Tanpa path → tidak dapat openFile (Req 3.4).
 * @property {number} [line]        Nomor baris pada file sumber (dipetakan dari line_number). Bilangan bulat positif; jika tidak valid pemakai memakai 1.
 * @property {string} [status]      Status resolusi; umumnya ada pada node error_file (mis. "COULD NOT RESOLVE LOCAL PATH") (Req 7.2/7.3).
 * @property {boolean} [hasErrorMarker] true untuk node bertipe error_file; penanda error yang selalu terlihat (Req 7.1).
 */

/**
 * EdgeVM — view model sebuah Edge dalam render model internal webview.
 * Hanya edge dengan `source` & `target` yang merujuk id node valid yang disertakan (Req 1.10).
 *
 * @typedef {Object} EdgeVM
 * @property {string} id            Identitas unik edge (stabil; mis. "<type>:<source>->>-<target>").
 * @property {string} source        Id node asal (harus merujuk NodeVM yang ada).
 * @property {string} target        Id node tujuan (harus merujuk NodeVM yang ada).
 * @property {string} type          Salah satu dari EDGE_TYPE_LIST (Req 1.5).
 * @property {string} [label]       Teks label opsional untuk edge.
 * @property {boolean} [unresolved] true bila relasi needs menunjuk target tanpa node bersesuaian (Req 7.5).
 */

/**
 * BuildResult — hasil GraphModelBuilder.build(deepGraph).
 *
 * @typedef {Object} BuildResult
 * @property {boolean} ok                       false bila deep_graph invalid / tak dapat diproses sebagai {nodes,edges} (Req 1.9).
 * @property {boolean} empty                    true bila deep_graph valid namun tanpa node (Req 1.8).
 * @property {boolean} overLimit                true bila jumlah node melebihi MAX_NODES (Req 6.6).
 * @property {Map<string, NodeVM>|Object<string, NodeVM>} nodes  Node terindeks by id (Map atau object literal by id).
 * @property {EdgeVM[]} edges                   Daftar edge valid (dangling sudah dibuang) (Req 1.10).
 * @property {Object<string, number>} edgeTypeCounts  Jumlah edge per tipe; satu entri untuk setiap tipe pada EDGE_TYPE_LIST.
 */

module.exports = {
  NODE_TYPES,
  NODE_TYPE_LIST,
  EDGE_TYPES,
  EDGE_TYPE_LIST,
  MAX_NODES,
  ZOOM_MIN,
  ZOOM_MAX,
};
