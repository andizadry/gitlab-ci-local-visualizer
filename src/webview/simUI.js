/**
 * simUI.js — Panel Skenario & Mode Simulasi untuk Pipeline Rules Simulator (Task 15).
 *
 * Modul webview (CommonJS, vanilla JS) yang dibundel inline via mini CommonJS runtime
 * (`scripts/build-webview.js`) dan diekspos sebagai `window.CIViz.createSimUI`. Ia menyentuh
 * DOM melalui `opts.doc` sehingga dapat diuji headless dengan jsdom.
 *
 * Tanggung jawab (Keputusan 6):
 *  - Membangun Panel Skenario: form pasangan key-value dinamis (tambah/hapus baris), field
 *    bernama variabel bawaan GitLab, `<select>` `CI_PIPELINE_SOURCE`, input daftar
 *    changed_files & exists_files, Preset, toggle Mode Simulasi, tombol Evaluate (Req 1, 2, 3, 13.1).
 *  - `getScenario()` menserialisasi form menjadi `{ variables, changed_files, exists_files }`
 *    tanpa mengubah key/value (Req 1.6).
 *  - `setMode(enabled)` mengelola Mode Simulasi (Req 13.2/13.3), `requestEvaluate()` mengirim
 *    `postMessage({ command:'simulate', scenario })` (Req 13.2/13.4).
 *  - `onSimulationResult(msg)` mendelegasikan ke GraphView.setSimulationResults + ringkasan status,
 *    banner pipeline-diblok (Req 8.6), dan penanganan error (Req 14.5).
 *
 * CSP tidak berubah: hanya membuat elemen form & memanggil `vscode.postMessage` (Req 15.2).
 */

'use strict';

const { t: L } = require('./i18n');

/**
 * Daftar Status_Job yang mungkin (untuk banner "semua NEVER" & ringkasan).
 * @type {string[]}
 */
const SIM_STATUSES = ['RUN', 'SKIP', 'MANUAL', 'DELAYED', 'NEVER'];

/**
 * Field variabel bawaan yang selalu ditampilkan sebagai input bernama (Req 1.4).
 * `select` menandai field yang dirender sebagai <select> (CI_PIPELINE_SOURCE).
 * @type {Array<{key:string, label:string, select?:boolean}>}
 */
const NAMED_VAR_FIELDS = [
  { key: 'CI_COMMIT_BRANCH', label: 'CI_COMMIT_BRANCH' },
  { key: 'CI_COMMIT_TAG', label: 'CI_COMMIT_TAG' },
  { key: 'CI_COMMIT_REF_NAME', label: 'CI_COMMIT_REF_NAME' },
  { key: 'CI_DEFAULT_BRANCH', label: 'CI_DEFAULT_BRANCH' },
  { key: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME', label: 'CI_MERGE_REQUEST_TARGET_BRANCH_NAME' },
  { key: 'CI_PIPELINE_SOURCE', label: 'CI_PIPELINE_SOURCE', select: true },
];

/** Opsi untuk <select> CI_PIPELINE_SOURCE (Req 1.5). */
const PIPELINE_SOURCE_OPTIONS = [
  'push', 'merge_request_event', 'web', 'schedule',
  'trigger', 'api', 'pipeline', 'parent_pipeline',
];

/** Kumpulan key field bawaan (untuk memisahkan dari pasangan key-value bebas). */
const NAMED_VAR_KEYS = NAMED_VAR_FIELDS.map((f) => f.key);

/**
 * Preset Skenario (Req 2.1, 2.2-2.6). Tiap preset mengembalikan tambalan (patch) atas nilai
 * field bernama. `null` pada sebuah field bermakna "kosongkan field itu".
 * @type {Object<string, {vars: Object<string,(string|null)>}>}
 */
const PRESETS = {
  'push to main': {
    vars: { CI_COMMIT_BRANCH: 'main', CI_PIPELINE_SOURCE: 'push', CI_COMMIT_TAG: null },
  },
  'merge request': {
    vars: { CI_PIPELINE_SOURCE: 'merge_request_event' },
  },
  'tag pipeline': {
    vars: { CI_COMMIT_TAG: 'v1.0.0', CI_COMMIT_BRANCH: null },
  },
  'scheduled': {
    vars: { CI_PIPELINE_SOURCE: 'schedule' },
  },
};

/** Daftar nama preset dalam urutan tampil. */
const PRESET_NAMES = ['push to main', 'merge request', 'tag pipeline', 'scheduled'];

/**
 * Helper murni: normalisasi objek Scenario menjadi bentuk kanonik & idempoten (Req 1.6).
 * - `variables`: objek {key:value} — key/value dipertahankan apa adanya (string); pasangan
 *   dengan key kosong (setelah trim) dibuang. Tidak mengubah casing/nilai.
 * - `changed_files` / `exists_files`: array string — baris kosong (setelah trim) dibuang.
 * Memanggil ulang atas hasilnya menghasilkan objek setara (idempoten).
 * @param {Object} obj
 * @returns {{variables:Object<string,string>, changed_files:string[], exists_files:string[]}}
 */
function normalizeScenario(obj) {
  const src = obj && typeof obj === 'object' ? obj : {};

  const variables = {};
  const rawVars = src.variables && typeof src.variables === 'object' ? src.variables : {};
  for (const key of Object.keys(rawVars)) {
    if (String(key).trim() === '') {
      continue; // buang key kosong.
    }
    const val = rawVars[key];
    variables[key] = val == null ? '' : String(val);
  }

  const normList = (arr) => {
    if (!Array.isArray(arr)) {
      return [];
    }
    const out = [];
    for (const item of arr) {
      const s = item == null ? '' : String(item);
      if (s.trim() !== '') {
        out.push(s);
      }
    }
    return out;
  };

  return {
    variables,
    changed_files: normList(src.changed_files),
    exists_files: normList(src.exists_files),
  };
}

/**
 * Factory createSimUI.
 *
 * @param {Element} container elemen host panel Skenario.
 * @param {Object} opts
 * @param {Document} opts.doc Document untuk membuat elemen (default global document).
 * @param {{postMessage:Function}} opts.vscode API webview untuk mengirim pesan ke host.
 * @param {Object} [opts.graphView] instance GraphView untuk delegasi badge simulasi.
 * @returns {Object} API simUI.
 */
function createSimUI(container, opts) {
  const options = opts || {};
  const doc = options.doc || (typeof document !== 'undefined' ? document : undefined);
  if (!doc) {
    throw new Error('createSimUI: butuh Document (opts.doc).');
  }
  if (!container) {
    throw new Error('createSimUI: butuh container elemen DOM.');
  }
  const vscode = options.vscode || null;
  const graphView = options.graphView || null;
  // Dipanggil saat hasil simulasi dibersihkan (Mode Simulasi off / simulasi gagal) agar
  // tampilan lain (kartu Standar, panel downstream) ikut dibersihkan.
  const onClear = typeof options.onClear === 'function' ? options.onClear : null;

  // ---- state internal ----
  let simMode = false;       // Mode Simulasi aktif? (Req 13.2/13.3)
  let lastResults = null;    // map hasil terakhir { <job>: JobSimResult }
  let snapshotResults = null; // v2.0.0 #3 — snapshot hasil untuk perbandingan Diff.
  let diffEl = null;         // host output Diff.
  let matrixEl = null;       // host output Matrix.

  // Referensi elemen kunci (diisi saat render()).
  let namedInputs = {};      // key -> <input>/<select>
  let kvRowsHost = null;     // host baris key-value bebas.
  let changedFilesEl = null; // <textarea> changed_files.
  let existsFilesEl = null;  // <textarea> exists_files.
  let modeToggleEl = null;   // checkbox Mode Simulasi.
  let summaryEl = null;      // host ringkasan status.
  let bannerEl = null;       // host banner (error / pipeline diblok).
  let detailEl = null;       // host detail alasan+when node terpilih.

  // ---- util pembuatan elemen ----
  function el(tag, attrs, text) {
    const node = doc.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null) {
          continue;
        }
        if (k === 'class') {
          node.className = v;
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (text != null) {
      node.textContent = String(text);
    }
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  // =========================================================================
  // Baris key-value bebas (Req 1.1-1.3)
  // =========================================================================

  /** Tambah satu baris key-value; mengisi nilai awal bila diberikan. */
  function addKvRow(key, value) {
    if (!kvRowsHost) {
      return null;
    }
    const row = el('div', { class: 'sim-kv-row' });

    const keyInput = el('input', {
      type: 'text', class: 'sim-kv-key', placeholder: 'KEY',
    });
    keyInput.value = key == null ? '' : String(key);

    const valInput = el('input', {
      type: 'text', class: 'sim-kv-value', placeholder: 'value',
    });
    valInput.value = value == null ? '' : String(value);

    const removeBtn = el('button', {
      type: 'button', class: 'sim-kv-remove', title: L('Hapus baris'),
    }, '\u2715');
    removeBtn.addEventListener('click', function () {
      if (row.parentNode) {
        row.parentNode.removeChild(row);
      }
    });

    row.appendChild(keyInput);
    row.appendChild(valInput);
    row.appendChild(removeBtn);
    kvRowsHost.appendChild(row);
    return row;
  }

  // =========================================================================
  // render() — bangun Panel Skenario (Req 1, 2, 3, 13.1)
  // =========================================================================

  /**
   * render(ciData) — bangun panel Skenario di container.
   * @param {Object} [ciData] data CI (opsional; tak wajib untuk membangun form).
   */
  function render(ciData) {
    clear(container);
    namedInputs = {};

    const panel = el('div', { class: 'sim-panel', 'data-sim-panel': 'true' });

    // Header + toggle Mode Simulasi + tombol Evaluate (Req 13.1).
    const header = el('div', { class: 'sim-header' });
    header.appendChild(el('span', { class: 'sim-title' }, L('Simulasi Rules')));

    const modeLabel = el('label', { class: 'sim-mode-toggle' });
    modeToggleEl = el('input', { type: 'checkbox', class: 'sim-mode-checkbox' });
    modeToggleEl.addEventListener('change', function () {
      setMode(!!modeToggleEl.checked);
    });
    modeLabel.appendChild(modeToggleEl);
    modeLabel.appendChild(el('span', null, L(' Mode Simulasi')));
    header.appendChild(modeLabel);

    const evalBtn = el('button', { type: 'button', class: 'sim-evaluate-btn' }, 'Evaluate');
    evalBtn.addEventListener('click', function () {
      requestEvaluate();
    });
    header.appendChild(evalBtn);
    panel.appendChild(header);

    // v2.0.0 #3 — baris kontrol Diff & Matrix.
    const toolsRow = el('div', { class: 'sim-tools-row' });
    const snapBtn = el('button', { type: 'button', class: 'sim-tool-btn', 'data-sim-snapshot': 'true' }, '\uD83D\uDCF7 Snapshot');
    snapBtn.addEventListener('click', function () { takeSnapshot(); });
    const diffBtn = el('button', { type: 'button', class: 'sim-tool-btn', 'data-sim-diff': 'true' }, '\u21C4 Diff vs Snapshot');
    diffBtn.addEventListener('click', function () { renderDiff(); });
    const matrixBtn = el('button', { type: 'button', class: 'sim-tool-btn', 'data-sim-matrix': 'true' }, '\u25A6 Run Preset Matrix');
    matrixBtn.addEventListener('click', function () { requestMatrix(); });
    toolsRow.appendChild(snapBtn);
    toolsRow.appendChild(diffBtn);
    toolsRow.appendChild(matrixBtn);
    panel.appendChild(toolsRow);

    // v2.0.0 #3 — host output Diff & Matrix.
    diffEl = el('div', { class: 'sim-diff', 'data-sim-diff-out': 'true', hidden: 'hidden' });
    panel.appendChild(diffEl);
    matrixEl = el('div', { class: 'sim-matrix', 'data-sim-matrix-out': 'true', hidden: 'hidden' });
    panel.appendChild(matrixEl);

    // Preset (Req 2.1).
    const presetRow = el('div', { class: 'sim-preset-row' });
    presetRow.appendChild(el('span', { class: 'sim-label' }, 'Preset:'));
    PRESET_NAMES.forEach(function (name) {
      const btn = el('button', {
        type: 'button', class: 'sim-preset-btn', 'data-preset': name,
      }, name);
      btn.addEventListener('click', function () {
        applyPreset(name);
      });
      presetRow.appendChild(btn);
    });
    panel.appendChild(presetRow);

    // Field variabel bawaan (Req 1.4, 1.5).
    const namedSection = el('div', { class: 'sim-named-vars' });
    NAMED_VAR_FIELDS.forEach(function (field) {
      const fieldRow = el('div', { class: 'sim-field-row' });
      fieldRow.appendChild(el('label', { class: 'sim-field-label', for: 'sim-var-' + field.key }, field.label));
      let input;
      if (field.select) {
        input = el('select', { class: 'sim-field-input', id: 'sim-var-' + field.key, 'data-var-key': field.key });
        PIPELINE_SOURCE_OPTIONS.forEach(function (optVal) {
          const optEl = el('option', { value: optVal }, optVal);
          input.appendChild(optEl);
        });
        input.value = 'push'; // default builtin (Req sesuai VariableResolver).
      } else {
        input = el('input', {
          type: 'text', class: 'sim-field-input',
          id: 'sim-var-' + field.key, 'data-var-key': field.key, placeholder: L('(tak terdefinisi)'),
        });
      }
      namedInputs[field.key] = input;
      fieldRow.appendChild(input);
      namedSection.appendChild(fieldRow);
    });
    panel.appendChild(namedSection);

    // Form pasangan key-value bebas (Req 1.1-1.3).
    const kvSection = el('div', { class: 'sim-kv-section' });
    const kvHead = el('div', { class: 'sim-subhead' });
    kvHead.appendChild(el('span', { class: 'sim-label' }, L('Variabel lain')));
    const addBtn = el('button', { type: 'button', class: 'sim-kv-add' }, L('+ Tambah'));
    addBtn.addEventListener('click', function () {
      addKvRow('', '');
    });
    kvHead.appendChild(addBtn);
    kvSection.appendChild(kvHead);

    kvRowsHost = el('div', { class: 'sim-kv-rows' });
    kvSection.appendChild(kvRowsHost);
    panel.appendChild(kvSection);

    // Daftar changed_files & exists_files (Req 3.1, 3.2).
    const filesSection = el('div', { class: 'sim-files-section' });

    const changedWrap = el('div', { class: 'sim-file-group' });
    changedWrap.appendChild(el('label', { class: 'sim-field-label', for: 'sim-changed-files' }, L('changed_files (satu path per baris)')));
    changedFilesEl = el('textarea', {
      class: 'sim-file-textarea', id: 'sim-changed-files', rows: 3, placeholder: 'src/app.js\nREADME.md',
    });
    changedWrap.appendChild(changedFilesEl);
    filesSection.appendChild(changedWrap);

    const existsWrap = el('div', { class: 'sim-file-group' });
    existsWrap.appendChild(el('label', { class: 'sim-field-label', for: 'sim-exists-files' }, L('exists_files (satu path per baris)')));
    existsFilesEl = el('textarea', {
      class: 'sim-file-textarea', id: 'sim-exists-files', rows: 3, placeholder: 'Dockerfile\npackage.json',
    });
    existsWrap.appendChild(existsFilesEl);
    filesSection.appendChild(existsWrap);

    panel.appendChild(filesSection);

    // Banner (error / pipeline diblok) — awalnya kosong (Req 8.6, 14.5).
    bannerEl = el('div', { class: 'sim-banner', 'data-sim-banner': 'true', hidden: 'hidden' });
    panel.appendChild(bannerEl);

    // Ringkasan status job (Req 12.1, 12.4).
    summaryEl = el('div', { class: 'sim-summary', 'data-sim-summary': 'true' });
    panel.appendChild(summaryEl);

    // Detail alasan + when efektif node terpilih (Req 12.3).
    detailEl = el('div', { class: 'sim-detail', 'data-sim-detail': 'true', hidden: 'hidden' });
    panel.appendChild(detailEl);

    container.appendChild(panel);

    // Sinkronkan status awal toggle.
    if (modeToggleEl) {
      modeToggleEl.checked = simMode;
    }
  }

  // =========================================================================
  // getScenario() — serialisasi form (Req 1.6)
  // =========================================================================

  /** Parse textarea daftar file → array baris non-kosong. */
  function parseFileList(textareaEl) {
    if (!textareaEl || textareaEl.value == null) {
      return [];
    }
    return String(textareaEl.value)
      .split('\n')
      .map(function (s) { return s.replace(/\r$/, ''); })
      .filter(function (s) { return s.trim() !== ''; });
  }

  /**
   * getScenario() — kumpulkan Scenario dari form. Tidak mengubah key/value (Req 1.6).
   * Menggabung field bernama + pasangan key-value bebas ke `variables`. Field bernama yang
   * kosong (string kosong) tidak dimasukkan (dianggap tak terdefinisi), kecuali <select>
   * yang selalu punya nilai terpilih.
   * @returns {{variables:Object<string,string>, changed_files:string[], exists_files:string[]}}
   */
  function getScenario() {
    const variables = {};

    // Field bernama.
    NAMED_VAR_FIELDS.forEach(function (field) {
      const input = namedInputs[field.key];
      if (!input) {
        return;
      }
      const val = input.value == null ? '' : String(input.value);
      if (field.select) {
        variables[field.key] = val; // select selalu punya nilai.
      } else if (val.trim() !== '') {
        variables[field.key] = val; // input teks kosong → tak terdefinisi.
      }
    });

    // Pasangan key-value bebas (belakangan menimpa bila key sama).
    if (kvRowsHost) {
      const rows = kvRowsHost.querySelectorAll('.sim-kv-row');
      for (let i = 0; i < rows.length; i += 1) {
        const keyEl = rows[i].querySelector('.sim-kv-key');
        const valEl = rows[i].querySelector('.sim-kv-value');
        const key = keyEl && keyEl.value != null ? String(keyEl.value) : '';
        if (key.trim() === '') {
          continue; // buang baris tanpa key (Req 1.6 — hanya baris kosong dibuang).
        }
        variables[key] = valEl && valEl.value != null ? String(valEl.value) : '';
      }
    }

    return {
      variables: variables,
      changed_files: parseFileList(changedFilesEl),
      exists_files: parseFileList(existsFilesEl),
    };
  }

  // =========================================================================
  // v2.0.0 #4 — setScenario(): isi ulang form dari objek Scenario (restore state).
  // =========================================================================

  /**
   * setScenario(scenario) — isi form dari objek { variables, changed_files, exists_files }.
   * Field bernama diisi dari variables (bila ada); sisanya jadi baris key-value bebas.
   * Aman dipanggil setelah render(). Tidak mengubah value yang tak tercakup.
   * @param {{variables?:Object, changed_files?:string[], exists_files?:string[]}} scenario
   */
  function setScenario(scenario) {
    const s = normalizeScenario(scenario);
    // Field bernama.
    NAMED_VAR_KEYS.forEach(function (key) {
      const input = namedInputs[key];
      if (!input) { return; }
      if (Object.prototype.hasOwnProperty.call(s.variables, key)) {
        input.value = s.variables[key];
      }
    });
    // Variabel bebas → tambah baris untuk key non-bawaan.
    if (kvRowsHost) {
      // Bersihkan baris lama.
      while (kvRowsHost.firstChild) { kvRowsHost.removeChild(kvRowsHost.firstChild); }
      Object.keys(s.variables).forEach(function (key) {
        if (NAMED_VAR_KEYS.indexOf(key) !== -1) { return; }
        addKvRow(key, s.variables[key]);
      });
    }
    // Daftar file.
    if (changedFilesEl) { changedFilesEl.value = (s.changed_files || []).join('\n'); }
    if (existsFilesEl) { existsFilesEl.value = (s.exists_files || []).join('\n'); }
  }

  // =========================================================================
  // Preset (Req 2.2-2.6)
  // =========================================================================

  /**
   * applyPreset(name) — isi field bernama sesuai preset. Nilai `null` mengosongkan field.
   * Perubahan manual sesudahnya dipertahankan (preset hanya menulis field yang tercakup, Req 2.6).
   * @param {string} name
   */
  function applyPreset(name) {
    const preset = Object.prototype.hasOwnProperty.call(PRESETS, name) ? PRESETS[name] : null;
    if (!preset) {
      return;
    }
    const vars = preset.vars || {};
    Object.keys(vars).forEach(function (key) {
      const input = namedInputs[key];
      if (!input) {
        return;
      }
      const val = vars[key];
      input.value = val == null ? '' : String(val);
    });
  }

  // =========================================================================
  // Mode Simulasi & Evaluate (Req 13.2-13.4)
  // =========================================================================

  /**
   * setMode(enabled) — aktifkan/nonaktifkan Mode Simulasi.
   * Aktif → langsung requestEvaluate() (Req 13.2). Nonaktif → hapus badge GraphView &
   * sembunyikan ringkasan/detail/banner (Req 13.3).
   * @param {boolean} enabled
   */
  function setMode(enabled) {
    simMode = !!enabled;
    if (modeToggleEl && modeToggleEl.checked !== simMode) {
      modeToggleEl.checked = simMode;
    }
    if (simMode) {
      requestEvaluate();
    } else {
      lastResults = null;
      if (graphView && typeof graphView.setSimulationResults === 'function') {
        graphView.setSimulationResults(null);
      }
      hideSummary();
      hideBanner();
      hideDetail();
      if (onClear) {
        onClear();
      }
    }
  }

  /**
   * requestEvaluate() — kirim Skenario ke host untuk dievaluasi (Req 13.2/13.4).
   */
  function requestEvaluate() {
    if (vscode && typeof vscode.postMessage === 'function') {
      vscode.postMessage({ command: 'simulate', scenario: getScenario() });
    }
  }

  // =========================================================================
  // onSimulationResult() — terima hasil (Req 8.6, 12.1, 12.4, 14.5)
  // =========================================================================

  /**
   * onSimulationResult(msg) — proses balasan host.
   *  - msg.error → banner error (Req 14.5).
   *  - msg.pipeline_created === false → banner "pipeline diblok" + semua job NEVER (Req 8.6).
   *  - selainnya → badge GraphView + ringkasan status (Req 12.1, 12.4).
   * @param {Object} msg { command:'simulationResult', pipeline_created?, workflow?, results?, error? }
   */
  function onSimulationResult(msg) {
    const data = msg || {};

    // Kasus error engine (Req 14.5).
    if (data.error != null && data.error !== false) {
      lastResults = null;
      if (graphView && typeof graphView.setSimulationResults === 'function') {
        graphView.setSimulationResults(null);
      }
      hideSummary();
      hideDetail();
      showBanner('error', L('Simulasi gagal: {0}', String(data.error)));
      if (onClear) {
        onClear();
      }
      return;
    }

    const results = data.results && typeof data.results === 'object' ? data.results : {};

    // Kasus pipeline diblok workflow:rules (Req 8.6).
    if (data.pipeline_created === false) {
      const neverMap = buildAllNeverMap(results);
      lastResults = neverMap;
      if (graphView && typeof graphView.setSimulationResults === 'function') {
        graphView.setSimulationResults(neverMap);
      }
      showBanner('blocked', L('Pipeline tidak dibuat (diblok workflow:rules)'));
      renderSummary(neverMap);
      hideDetail();
      return;
    }

    // Kasus normal (Req 12.1, 12.4).
    lastResults = results;
    hideBanner();
    if (graphView && typeof graphView.setSimulationResults === 'function') {
      graphView.setSimulationResults(results);
    }
    renderSummary(results);
    hideDetail();
  }

  /** Bangun map semua job → JobSimResult berstatus NEVER (Req 8.6). */
  function buildAllNeverMap(results) {
    const out = {};
    const names = results && typeof results === 'object' ? Object.keys(results) : [];
    for (const name of names) {
      const base = results[name] && typeof results[name] === 'object' ? results[name] : {};
      out[name] = {
        status: 'NEVER',
        when_effective: base.when_effective != null ? base.when_effective : null,
        matched_rule_index: base.matched_rule_index != null ? base.matched_rule_index : null,
        reason: L('pipeline diblok oleh workflow:rules'),
        effective_variables: base.effective_variables || {},
        error: base.error != null ? base.error : null,
      };
    }
    return out;
  }

  // =========================================================================
  // Ringkasan status & detail (Req 12.1, 12.3, 12.4)
  // =========================================================================

  /** Render ringkasan daftar job → status; klik item menampilkan detail (Req 12.4, 12.3). */
  function renderSummary(results) {
    if (!summaryEl) {
      return;
    }
    clear(summaryEl);
    summaryEl.removeAttribute('hidden');

    const names = results && typeof results === 'object' ? Object.keys(results).sort() : [];
    if (!names.length) {
      summaryEl.appendChild(el('div', { class: 'sim-summary-empty' }, L('Tidak ada job untuk ditampilkan.')));
      return;
    }

    summaryEl.appendChild(el('div', { class: 'sim-subhead sim-label' }, L('Ringkasan Status')));
    const list = el('div', { class: 'sim-summary-list' });
    names.forEach(function (name) {
      const result = results[name] || {};
      const hasError = result.error != null && String(result.error).trim() !== '';
      const status = hasError ? 'ERROR' : String(result.status || '');
      const item = el('div', {
        class: 'sim-summary-item sim-status-' + status,
        'data-job-name': name,
        'data-status': status,
      });
      item.appendChild(el('span', { class: 'sim-summary-status' }, status));
      item.appendChild(el('span', { class: 'sim-summary-job' }, name));
      item.addEventListener('click', function () {
        showDetail(name, result);
      });
      list.appendChild(item);
    });
    summaryEl.appendChild(list);
  }

  /** Sembunyikan ringkasan (Req 13.3). */
  function hideSummary() {
    if (summaryEl) {
      clear(summaryEl);
      summaryEl.setAttribute('hidden', 'hidden');
    }
  }

  /**
   * showDetail(jobName, result) — tampilkan alasan + when efektif untuk job terpilih (Req 12.3).
   * Dipanggil dari klik item ringkasan atau dari GraphView.onSimSelect.
   * @param {string} jobName
   * @param {Object} result JobSimResult.
   */
  function showDetail(jobName, result) {
    if (!detailEl) {
      return;
    }
    const r = result || {};
    clear(detailEl);
    detailEl.removeAttribute('hidden');

    const hasError = r.error != null && String(r.error).trim() !== '';
    detailEl.appendChild(el('div', { class: 'sim-detail-title' }, 'Job: ' + String(jobName)));
    detailEl.appendChild(el('div', { class: 'sim-detail-status' },
      'Status: ' + (hasError ? 'ERROR' : String(r.status || L('(tak diketahui)')))));
    detailEl.appendChild(el('div', { class: 'sim-detail-when' },
      L('when efektif: ') + (r.when_effective != null ? String(r.when_effective) : L('(tidak ada)'))));
    detailEl.appendChild(el('div', { class: 'sim-detail-reason' },
      L('Alasan: ') + (r.reason != null ? String(r.reason) : L('(tidak ada)'))));
    if (hasError) {
      detailEl.appendChild(el('div', { class: 'sim-detail-error' },
        'Error: ' + String(r.error)));
    }
  }

  /** Sembunyikan detail. */
  function hideDetail() {
    if (detailEl) {
      clear(detailEl);
      detailEl.setAttribute('hidden', 'hidden');
    }
  }

  // =========================================================================
  // Banner (Req 8.6, 14.5)
  // =========================================================================

  /** Tampilkan banner dengan jenis ('error'/'blocked') & pesan. */
  function showBanner(kind, message) {
    if (!bannerEl) {
      return;
    }
    bannerEl.className = 'sim-banner sim-banner-' + kind;
    bannerEl.setAttribute('data-banner-kind', kind);
    bannerEl.textContent = message;
    bannerEl.removeAttribute('hidden');
  }

  /** Sembunyikan banner. */
  function hideBanner() {
    if (bannerEl) {
      bannerEl.className = 'sim-banner';
      bannerEl.removeAttribute('data-banner-kind');
      bannerEl.textContent = '';
      bannerEl.setAttribute('hidden', 'hidden');
    }
  }

  // =========================================================================
  // v2.0.0 #3 — Diff & Matrix
  // =========================================================================

  /** Ambil status efektif satu JobSimResult (ERROR bila ada error). */
  function statusOf(result) {
    const r = result || {};
    if (r.error != null && String(r.error).trim() !== '') {
      return 'ERROR';
    }
    return String(r.status || '');
  }

  /** Simpan hasil terkini sebagai snapshot pembanding. */
  function takeSnapshot() {
    snapshotResults = lastResults ? JSON.parse(JSON.stringify(lastResults)) : null;
    if (diffEl) {
      diffEl.removeAttribute('hidden');
      clear(diffEl);
      diffEl.appendChild(el('div', { class: 'sim-subhead sim-label' }, 'Snapshot'));
      diffEl.appendChild(el('div', { class: 'sim-diff-note' },
        snapshotResults
          ? L('Snapshot tersimpan. Ubah skenario, Evaluate, lalu klik Diff.')
          : L('Belum ada hasil untuk di-snapshot. Evaluate dulu.')));
    }
  }

  /**
   * renderDiff() — bandingkan snapshot vs hasil terkini per job.
   * Menyorot job yang berubah status (A → B), job baru, dan job hilang.
   */
  function renderDiff() {
    if (!diffEl) {
      return;
    }
    clear(diffEl);
    diffEl.removeAttribute('hidden');
    diffEl.appendChild(el('div', { class: 'sim-subhead sim-label' }, L('Diff (Snapshot \u2192 Sekarang)')));

    if (!snapshotResults) {
      diffEl.appendChild(el('div', { class: 'sim-diff-note' }, L('Belum ada snapshot. Klik Snapshot dulu.')));
      return;
    }
    if (!lastResults) {
      diffEl.appendChild(el('div', { class: 'sim-diff-note' }, L('Belum ada hasil terkini. Evaluate dulu.')));
      return;
    }

    const names = {};
    Object.keys(snapshotResults).forEach(function (n) { names[n] = true; });
    Object.keys(lastResults).forEach(function (n) { names[n] = true; });
    const sorted = Object.keys(names).sort();

    const list = el('div', { class: 'sim-diff-list' });
    let changes = 0;
    sorted.forEach(function (name) {
      const before = snapshotResults[name];
      const after = lastResults[name];
      const bs = before ? statusOf(before) : null;
      const as = after ? statusOf(after) : null;
      let kind = 'same';
      let text = '';
      if (bs == null) { kind = 'added'; text = '+ ' + name + ': (baru) \u2192 ' + as; }
      else if (as == null) { kind = 'removed'; text = '- ' + name + ': ' + bs + ' \u2192 (hilang)'; }
      else if (bs !== as) { kind = 'changed'; text = '~ ' + name + ': ' + bs + ' \u2192 ' + as; }
      else { text = '= ' + name + ': ' + bs; }
      if (kind !== 'same') { changes += 1; }
      const item = el('div', { class: 'sim-diff-item sim-diff-' + kind }, text);
      list.appendChild(item);
    });
    diffEl.appendChild(el('div', { class: 'sim-diff-note' },
      changes ? L('{0} job berubah.', changes) : L('Tidak ada perubahan status.')));
    diffEl.appendChild(list);
  }

  /**
   * requestMatrix() — kirim daftar skenario preset ke host untuk dievaluasi sekaligus.
   * Skenario dibangun dari getScenario() saat ini sebagai basis, lalu tiap preset di-overlay.
   */
  function requestMatrix() {
    if (!(vscode && typeof vscode.postMessage === 'function')) {
      return;
    }
    const base = getScenario();
    const scenarios = PRESET_NAMES.map(function (presetName) {
      const preset = PRESETS[presetName] || { vars: {} };
      const vars = Object.assign({}, base.variables);
      Object.keys(preset.vars || {}).forEach(function (k) {
        const v = preset.vars[k];
        if (v == null) { delete vars[k]; } else { vars[k] = String(v); }
      });
      return {
        label: presetName,
        scenario: {
          variables: vars,
          changed_files: base.changed_files.slice(),
          exists_files: base.exists_files.slice(),
        },
      };
    });
    if (matrixEl) {
      matrixEl.removeAttribute('hidden');
      clear(matrixEl);
      matrixEl.appendChild(el('div', { class: 'sim-subhead sim-label' }, 'Matrix'));
      matrixEl.appendChild(el('div', { class: 'sim-diff-note' }, L('Menjalankan {0} preset\u2026', scenarios.length)));
    }
    vscode.postMessage({ command: 'simulateMatrix', scenarios: scenarios });
  }

  /**
   * onMatrixResult(msg) — render tabel job × preset dari balasan host.
   * @param {Object} msg { command:'simulationMatrixResult', columns:[{label, results?, error?, pipeline_created?}] }
   */
  function onMatrixResult(msg) {
    if (!matrixEl) {
      return;
    }
    clear(matrixEl);
    matrixEl.removeAttribute('hidden');
    matrixEl.appendChild(el('div', { class: 'sim-subhead sim-label' }, 'Matrix (job \u00D7 preset)'));

    const columns = (msg && Array.isArray(msg.columns)) ? msg.columns : [];
    if (!columns.length) {
      matrixEl.appendChild(el('div', { class: 'sim-diff-note' }, L('Tidak ada hasil matrix.')));
      return;
    }

    // Kumpulkan semua nama job dari seluruh kolom.
    const jobSet = {};
    columns.forEach(function (col) {
      const res = col && col.results && typeof col.results === 'object' ? col.results : {};
      Object.keys(res).forEach(function (n) { jobSet[n] = true; });
    });
    const jobs = Object.keys(jobSet).sort();
    if (!jobs.length) {
      matrixEl.appendChild(el('div', { class: 'sim-diff-note' }, L('Tidak ada job pada hasil matrix.')));
      return;
    }

    const table = el('table', { class: 'sim-matrix-table' });
    const thead = el('thead');
    const hrow = el('tr');
    hrow.appendChild(el('th', { class: 'sim-matrix-jobcol' }, 'Job'));
    columns.forEach(function (col) {
      const blocked = col && col.pipeline_created === false;
      const th = el('th', { title: col && col.error ? String(col.error) : '' },
        String(col && col.label ? col.label : '?') + (blocked ? ' \u26D4' : ''));
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = el('tbody');
    jobs.forEach(function (job) {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'sim-matrix-jobcol' }, job));
      columns.forEach(function (col) {
        const res = col && col.results && typeof col.results === 'object' ? col.results : {};
        let status;
        if (col && col.error) { status = 'ERR'; }
        else if (col && col.pipeline_created === false) { status = 'NEVER'; }
        else { status = res[job] ? statusOf(res[job]) : '\u2013'; }
        const td = el('td', { class: 'sim-matrix-cell sim-status-' + status }, status);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    matrixEl.appendChild(table);
  }

  // Hubungkan seleksi node GraphView → detail (Req 12.3), bila GraphView mendukung onSimSelect
  // via opsi saat pembuatannya. simUI juga menyediakan callback publik untuk itu.

  // ---- API publik ----
  return {
    render,
    getScenario,
    setScenario,
    applyPreset,
    setMode,
    requestEvaluate,
    onSimulationResult,
    // v2.0.0 #3 — Diff & Matrix.
    takeSnapshot,
    renderDiff,
    requestMatrix,
    onMatrixResult,
    // getter/util tambahan untuk host & test.
    isSimMode: function () { return simMode; },
    getLastResults: function () { return lastResults; },
    getSnapshot: function () { return snapshotResults; },
    showDetail,
    // callback untuk GraphView.onSimSelect (nodeId sudah di-strip jadi jobName oleh GraphView).
    onNodeSimSelect: function (jobName, result) { showDetail(jobName, result); },
  };
}

module.exports = {
  createSimUI,
  normalizeScenario,
  // konstanta diekspor untuk pengujian & pemakaian ulang.
  NAMED_VAR_FIELDS,
  PIPELINE_SOURCE_OPTIONS,
  PRESETS,
  PRESET_NAMES,
  SIM_STATUSES,
};
