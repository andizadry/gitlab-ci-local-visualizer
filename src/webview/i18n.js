/**
 * i18n.js — terjemahan UI webview (en / id).
 *
 * Teks sumber di kode ditulis dalam bahasa Indonesia dan sekaligus menjadi KEY.
 * `t(key, ...params)` mengembalikan teks sesuai bahasa aktif:
 *  - 'id' → key apa adanya,
 *  - 'en' → `EN[key]` (fallback ke key bila belum ada terjemahan).
 * Placeholder `{0}`, `{1}`, ... diganti dengan parameter berurutan.
 *
 * Bahasa aktif di-set sekali saat bootstrap lewat `setLanguage(ciData.ui_lang)`.
 */

'use strict';

/** @type {Object<string,string>} terjemahan Inggris, key = teks sumber (Indonesia). */
const EN = {
  // ---- header / toolbar / static HTML ----
  'Pipeline downstream (child / multi-project)': 'Downstream pipelines (child / multi-project)',
  'Cari job / node...': 'Search job / node...',
  'Standar': 'Standard',
  'Detail': 'Detail',
  'Ganti arah layout (LR/TB)': 'Toggle layout direction (LR/TB)',
  'Tampilkan/sembunyikan minimap': 'Show/hide minimap',
  'Salin SVG graf ke clipboard': 'Copy graph SVG to clipboard',
  'Unduh PNG graf': 'Download graph PNG',
  'Salin Graphviz DOT ke clipboard': 'Copy Graphviz DOT to clipboard',

  // ---- webview.src.html (bootstrap) ----
  'Modul graf gagal dimuat.': 'Graph module failed to load.',
  'Gagal render PNG': 'Failed to render PNG',
  'Export PNG gagal: {0}': 'PNG export failed: {0}',
  'Tidak ada job untuk ditampilkan.': 'No jobs to display.',
  '(tidak ada)': '(none)',
  'Tidak ada lokasi sumber untuk item ini': 'No source location for this item',
  'Include tidak terselesaikan — tidak ada file sumber': 'Unresolved include — no source file',
  'SVG graf disalin ke clipboard': 'Graph SVG copied to clipboard',
  'Graphviz DOT disalin ke clipboard': 'Graphviz DOT copied to clipboard',
  'Clipboard tidak tersedia': 'Clipboard is not available',
  'pakai file contoh': 'using sample file',
  'dynamic · belum ada contoh': 'dynamic · no sample yet',
  'sebagian ter-resolve': 'partially resolved',
  'tidak ter-resolve': 'unresolved',
  'siklus': 'cycle',
  'terlalu dalam': 'too deep',
  'terpicu': 'triggered',
  'terpicu setelah manual/delayed': 'triggered after manual/delayed',
  'tidak terpicu': 'not triggered',
  'depend tidak lagi direkomendasikan; gunakan mirror': 'depend is no longer recommended; use mirror',
  'bridge job meniru status pipeline downstream': 'bridge job mirrors the downstream pipeline status',
  'Tidak ada job yang bisa ditampilkan.': 'No jobs to display.',
  '📂 Pilih file contoh…': '📂 Choose sample file…',
  '↗ Buka file contoh': '↗ Open sample file',
  '✖ Hapus pilihan': '✖ Clear selection',
  'Jenis': 'Kind',
  '(default: bridge sukses saat pipeline terbuat)': '(default: bridge succeeds once the pipeline is created)',
  'Konfigurasi': 'Configuration',
  'Sumber konfigurasi child': 'Child configuration sources',
  'Tidak bisa diresolve offline': 'Cannot be resolved offline',
  'Child dinamis (dibuat saat runtime)': 'Dynamic child (generated at runtime)',
  'File contoh': 'Sample file',
  '(belum ada)': '(none yet)',
  'Sumber contoh': 'Sample source',
  'Simulasi': 'Simulation',
  'Alasan': 'Reason',
  'pipeline tidak dibuat': 'pipeline not created',
  'Variabel yang diteruskan bridge': 'Variables forwarded by the bridge',
  'Variabel efektif di pipeline downstream': 'Effective variables in the downstream pipeline',
  'Temuan validasi child ({0})': 'Child validation findings ({0})',
  '📂 Buka bridge job (trigger) di editor': '📂 Open bridge job (trigger) in editor',
  'Jalankan simulasi (Panel Skenario) untuk melihat evaluasi rules langkah demi langkah.':
    'Run a simulation (Scenario Panel) to see the rules evaluation step by step.',
  'Hasil: ': 'Result: ',
  '(Tidak ada rules eksplisit untuk job ini)': '(No explicit rules for this job)',
  '# gagal resolve: {0}': '# failed to resolve: {0}',
  'Tidak ada lokasi sumber untuk target ini': 'No source location for this target',
  'status tidak tersedia': 'status not available',
  'Aksi buka file tidak tersedia: node ini tidak memiliki path ke file yang ada.':
    'Open-file action unavailable: this node has no path to an existing file.',

  // ---- simUI.js ----
  'Hapus baris': 'Remove row',
  'Simulasi Rules': 'Rules Simulation',
  ' Mode Simulasi': ' Simulation Mode',
  '(tak terdefinisi)': '(undefined)',
  'Variabel lain': 'Other variables',
  '+ Tambah': '+ Add',
  'changed_files (satu path per baris)': 'changed_files (one path per line)',
  'exists_files (satu path per baris)': 'exists_files (one path per line)',
  'Simulasi gagal: {0}': 'Simulation failed: {0}',
  'Pipeline tidak dibuat (diblok workflow:rules)': 'Pipeline not created (blocked by workflow:rules)',
  'pipeline diblok oleh workflow:rules': 'pipeline blocked by workflow:rules',
  'Ringkasan Status': 'Status Summary',
  '(tak diketahui)': '(unknown)',
  'when efektif: ': 'effective when: ',
  'Alasan: ': 'Reason: ',
  'Snapshot tersimpan. Ubah skenario, Evaluate, lalu klik Diff.':
    'Snapshot saved. Change the scenario, Evaluate, then click Diff.',
  'Belum ada hasil untuk di-snapshot. Evaluate dulu.': 'No results to snapshot yet. Evaluate first.',
  'Diff (Snapshot → Sekarang)': 'Diff (Snapshot → Now)',
  'Belum ada snapshot. Klik Snapshot dulu.': 'No snapshot yet. Click Snapshot first.',
  'Belum ada hasil terkini. Evaluate dulu.': 'No current results yet. Evaluate first.',
  '{0} job berubah.': '{0} job(s) changed.',
  'Tidak ada perubahan status.': 'No status changes.',
  'Menjalankan {0} preset…': 'Running {0} preset(s)…',
  'Tidak ada hasil matrix.': 'No matrix results.',
  'Tidak ada job pada hasil matrix.': 'No jobs in the matrix results.',

  // ---- graphView.js ----
  'Tidak ada data graf untuk ditampilkan': 'No graph data to display',
  'Gagal memuat data graf': 'Failed to load graph data',
  'Ukuran graf melebihi batas maksimum (>1000 node)': 'Graph size exceeds the maximum limit (>1000 nodes)',
  'Merender graf…': 'Rendering graph…',
  'Open file (tak tersedia)': 'Open file (unavailable)',
  'Legenda graf': 'Graph legend',
  'Relasi (Edge)': 'Relations (Edge)',
  '{0} (tak terselesaikan)': '{0} (unresolved)',
};

const SUPPORTED = ['en', 'id'];
let current = 'en';

function normalizeLang(lang) {
  const s = String(lang || '').trim().toLowerCase();
  return s.indexOf('id') === 0 ? 'id' : 'en';
}

/** Set bahasa aktif ('en' | 'id'; nilai lain → 'en'). */
function setLanguage(lang) {
  current = normalizeLang(lang);
  return current;
}

function getLanguage() {
  return current;
}

function format(str, params) {
  if (!params || !params.length) return str;
  return String(str).replace(/\{(\d+)\}/g, function (m, i) {
    const v = params[Number(i)];
    return v === undefined ? m : String(v);
  });
}

/**
 * Terjemahkan teks sumber (Indonesia) ke bahasa aktif.
 * @param {string} key teks sumber
 * @param {...*} params pengganti {0}, {1}, ...
 */
function t(key) {
  const params = Array.prototype.slice.call(arguments, 1);
  let s = key;
  if (current === 'en' && Object.prototype.hasOwnProperty.call(EN, key)) s = EN[key];
  return format(s, params);
}

module.exports = { t, setLanguage, getLanguage, normalizeLang, EN, SUPPORTED };
