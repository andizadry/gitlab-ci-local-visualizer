/**
 * interaction.js — Logika murni zoom & pan untuk Dependency Graph Visualizer.
 *
 * Modul logika murni webview (vanilla JS, CommonJS, tanpa dependency runtime eksternal).
 * File ini di-inline ke `webview.html` saat build agar patuh CSP & 100% offline (Req 8),
 * dan di-`require` langsung oleh test headless (fast-check/vitest).
 *
 * Fungsi-fungsi inti (clampZoom, applyPan, panSequence) bersifat MURNI: tidak menyentuh
 * DOM, tidak menyimpan state, deterministik, dan tidak memutasi argumen. Ini membuatnya
 * mudah diuji secara property-based:
 *   - clampZoom  → Req 1.6 (zoom selalu ter-clamp pada 10%–400%, idempoten dalam rentang).
 *   - applyPan / panSequence → Req 1.7 (pan bersifat aditif terhadap delta geseran).
 *
 * InteractionController (opsional) hanya membungkus state {scale, offset} dan mendelegasikan
 * ke fungsi murni; ia disediakan untuk kenyamanan pemakaian di sisi webview.
 *
 * Requirements terkait: 1.6 (rentang zoom 10%–400%), 1.7 (pan aditif).
 */

'use strict';

const { ZOOM_MIN, ZOOM_MAX } = require('./types');

/**
 * Clamp tingkat zoom ke rentang [ZOOM_MIN, ZOOM_MAX] (10%–400%, Req 1.6).
 *
 * Sifat:
 *  - Idempoten: nilai yang sudah berada dalam rentang dikembalikan apa adanya,
 *    sehingga clampZoom(clampZoom(x)) === clampZoom(x).
 *  - Aman terhadap input buruk: nilai non-number atau NaN dikembalikan sebagai
 *    ZOOM_MIN (fallback aman), bukan melempar error.
 *
 * @param {number} scale Tingkat zoom yang diminta (mis. 1 = 100%).
 * @returns {number} Tingkat zoom yang telah di-clamp ke [ZOOM_MIN, ZOOM_MAX].
 */
function clampZoom(scale) {
  if (typeof scale !== 'number' || Number.isNaN(scale)) {
    return ZOOM_MIN;
  }
  if (scale < ZOOM_MIN) {
    return ZOOM_MIN;
  }
  if (scale > ZOOM_MAX) {
    return ZOOM_MAX;
  }
  return scale;
}

/**
 * Terapkan satu delta geseran (pan) pada offset saat ini (Req 1.7).
 * Murni & tidak memutasi argumen: mengembalikan objek offset baru.
 *
 * @param {{x:number,y:number}} offset Offset pandang saat ini.
 * @param {{dx:number,dy:number}} delta Delta geseran (arah & jarak).
 * @returns {{x:number,y:number}} Offset baru = {x: offset.x + dx, y: offset.y + dy}.
 */
function applyPan(offset, delta) {
  const ox = offset && typeof offset.x === 'number' ? offset.x : 0;
  const oy = offset && typeof offset.y === 'number' ? offset.y : 0;
  const dx = delta && typeof delta.dx === 'number' ? delta.dx : 0;
  const dy = delta && typeof delta.dy === 'number' ? delta.dy : 0;
  return { x: ox + dx, y: oy + dy };
}

/**
 * Terapkan berurutan sederet delta geseran pada offset awal (Req 1.7).
 *
 * Karena pan bersifat aditif, offset akhir sama dengan offset awal ditambah
 * jumlah seluruh delta pada `deltas`, tanpa bergantung pada pengelompokan/urutan
 * penjumlahan. Diimplementasikan sebagai reduce atas applyPan.
 *
 * @param {{x:number,y:number}} initialOffset Offset awal.
 * @param {Array<{dx:number,dy:number}>} deltas Deret delta geseran.
 * @returns {{x:number,y:number}} Offset akhir = initialOffset + Σ deltas.
 */
function panSequence(initialOffset, deltas) {
  const start = applyPan(initialOffset, { dx: 0, dy: 0 }); // normalisasi ke {x,y} baru
  if (!Array.isArray(deltas)) {
    return start;
  }
  return deltas.reduce((offset, delta) => applyPan(offset, delta), start);
}

/**
 * InteractionController — pembungkus stateful (opsional) atas fungsi murni di atas.
 * Menyimpan {scale, offset} dan menyediakan method zoom()/pan() untuk sisi webview.
 * Semua transisi state tetap mendelegasikan ke clampZoom & applyPan.
 */
class InteractionController {
  /**
   * @param {{scale?:number, offset?:{x:number,y:number}}} [initial]
   */
  constructor(initial) {
    const init = initial || {};
    this.scale = clampZoom(typeof init.scale === 'number' ? init.scale : 1);
    this.offset = applyPan(init.offset, { dx: 0, dy: 0 });
  }

  /**
   * Set tingkat zoom absolut, di-clamp ke [ZOOM_MIN, ZOOM_MAX] (Req 1.6).
   * @param {number} scale Tingkat zoom absolut yang diinginkan.
   * @returns {number} Tingkat zoom efektif setelah clamp.
   */
  zoom(scale) {
    this.scale = clampZoom(scale);
    return this.scale;
  }

  /**
   * Zoom relatif dengan faktor pengali terhadap tingkat zoom saat ini,
   * di-clamp ke rentang (Req 1.6).
   * @param {number} factor Faktor pengali (mis. 1.1 untuk zoom-in 10%).
   * @returns {number} Tingkat zoom efektif setelah clamp.
   */
  zoomBy(factor) {
    const f = typeof factor === 'number' && !Number.isNaN(factor) ? factor : 1;
    this.scale = clampZoom(this.scale * f);
    return this.scale;
  }

  /**
   * Geser (pan) offset pandang sebesar (dx, dy) — aditif (Req 1.7).
   * @param {number} dx Geseran horizontal.
   * @param {number} dy Geseran vertikal.
   * @returns {{x:number,y:number}} Offset baru.
   */
  pan(dx, dy) {
    this.offset = applyPan(this.offset, { dx, dy });
    return this.offset;
  }

  /**
   * Snapshot state saat ini (salinan dangkal offset).
   * @returns {{scale:number, offset:{x:number,y:number}}}
   */
  getState() {
    return { scale: this.scale, offset: { x: this.offset.x, y: this.offset.y } };
  }
}

/**
 * Zoom dengan mempertahankan titik `point` (koordinat piksel relatif viewport)
 * tetap di posisi layar yang sama (zoom-to-cursor). Murni, tidak memutasi argumen.
 *
 * @param {{scale:number, offset:{x:number,y:number}}} state State pandang saat ini.
 * @param {number} factor Faktor pengali zoom terhadap state.scale.
 * @param {{x:number,y:number}} point Titik jangkar dalam piksel viewport.
 * @returns {{scale:number, offset:{x:number,y:number}}} State baru (scale ter-clamp, offset disesuaikan).
 */
function zoomAtPoint(state, factor, point) {
  const s = state || {};
  const curScale = typeof s.scale === 'number' && !Number.isNaN(s.scale) && s.scale !== 0 ? s.scale : 1;
  const off = s.offset && typeof s.offset.x === 'number' && typeof s.offset.y === 'number' ? s.offset : { x: 0, y: 0 };
  const f = typeof factor === 'number' && !Number.isNaN(factor) ? factor : 1;
  const pt = point && typeof point.x === 'number' && typeof point.y === 'number' ? point : { x: 0, y: 0 };

  const newScale = clampZoom(curScale * f);
  const worldX = (pt.x - off.x) / curScale;
  const worldY = (pt.y - off.y) / curScale;
  const newOffsetX = pt.x - worldX * newScale;
  const newOffsetY = pt.y - worldY * newScale;
  return { scale: newScale, offset: { x: newOffsetX, y: newOffsetY } };
}
/**
 * Hitung state {scale, offset} agar contentBox (dunia) pas & terpusat di viewportBox
 * (piksel), dengan padding di sekelilingnya. Murni & aman terhadap input degeneratif.
 *
 * @param {{width:number,height:number}} contentBox Ukuran konten (koordinat dunia).
 * @param {{width:number,height:number}} viewportBox Ukuran viewport (piksel).
 * @param {number} [padding=40] Padding piksel di sekeliling konten.
 * @returns {{scale:number, offset:{x:number,y:number}}} State fit-to-view (ter-clamp & terpusat).
 */
function fitView(contentBox, viewportBox, padding) {
  const pad = typeof padding === 'number' && !Number.isNaN(padding) ? padding : 40;
  const c = contentBox || {};
  const v = viewportBox || {};
  const cw = typeof c.width === 'number' ? c.width : 0;
  const ch = typeof c.height === 'number' ? c.height : 0;
  const vw = typeof v.width === 'number' ? v.width : 0;
  const vh = typeof v.height === 'number' ? v.height : 0;

  if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) {
    return { scale: 1, offset: { x: pad, y: pad } };
  }

  const sx = (vw - 2 * pad) / cw;
  const sy = (vh - 2 * pad) / ch;
  let scale = clampZoom(Math.min(sx, sy));
  if (!(scale > 0)) {
    scale = clampZoom(1);
  }
  const offsetX = (vw - cw * scale) / 2;
  const offsetY = (vh - ch * scale) / 2;
  return { scale, offset: { x: offsetX, y: offsetY } };
}
module.exports = {
  clampZoom,
  zoomAtPoint,
  fitView,
  applyPan,
  panSequence,
  InteractionController,
};
