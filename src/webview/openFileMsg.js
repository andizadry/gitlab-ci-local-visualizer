/**
 * openFileMsg.js — Pembangun pesan `openFile` untuk jump-to-source.
 *
 * Modul logika murni webview (vanilla JS, CommonJS, tanpa dependency runtime eksternal).
 * File ini di-inline ke `webview.html` saat build agar patuh CSP & 100% offline (Req 8),
 * dan di-`require` langsung oleh test headless serta pemanggil di webview
 * (klik node graf, file card, tombol "Open Source File", elemen extends/needs/include).
 *
 * Kontrak (Keputusan 4, Property 5):
 *   buildOpenFileMsg(target) -> { command:'openFile', path, line } | null
 * Skema pesan tunggal dipakai semua jalur openFile; `extension.js` sudah menerima
 * `{ command:'openFile', path, line }` apa adanya sehingga tidak perlu diubah.
 *
 * Requirements terkait: 3.1 (buka file dari klik), 3.4 (target tanpa path → tidak
 * ada aksi buka), 4.4 (kirim line ke handler), 4.6 (relasi tanpa Source_Location →
 * tidak menghasilkan pesan), 4.7 (ada path tanpa line valid → line = 1),
 * 7.4 (node error_file tanpa path ke file → tidak dapat dibuka).
 */

'use strict';

/**
 * Bangun pesan `openFile` dari sebuah target (NodeVM atau target relasi).
 *
 * Aturan:
 * - Ambil `path` dari `target.path`. Jika falsy (mis. undefined/''), kembalikan `null`
 *   (Req 3.4, 4.6, 7.4) — tidak ada file yang dapat dibuka.
 * - Tentukan `line` dari `target.line` bila ada, selain itu `target.line_number`.
 *   Nilai dipakai hanya bila berupa bilangan bulat positif (>= 1); selain itu
 *   (undefined / 0 / negatif / non-integer / NaN) gunakan `1` (Req 4.7).
 * - Kembalikan `{ command:'openFile', path, line }`.
 *
 * @param {Object} target  Objek target; punya `path` (opsional) dan `line`/`line_number` (opsional).
 * @returns {{ command: 'openFile', path: string, line: number } | null}
 */
function buildOpenFileMsg(target) {
  if (!target) {
    return null;
  }

  const path = target.path;
  if (!path) {
    return null;
  }

  const rawLine = target.line != null ? target.line : target.line_number;
  const line = Number.isInteger(rawLine) && rawLine >= 1 ? rawLine : 1;

  return { command: 'openFile', path: path, line: line };
}

module.exports = {
  buildOpenFileMsg,
};
