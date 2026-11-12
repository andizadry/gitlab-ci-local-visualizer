// @vitest-environment node
/**
 * Integrasi end-to-end: engine Python (fixture dummy) -> webview.html (jsdom).
 * Memverifikasi tampilan pipeline downstream: parent-child, dynamic child (placeholder & contoh),
 * simulasi (forward variabel, bridge manual), drawer, dan graf Detail.
 * Dilewati otomatis bila python3 + PyYAML tidak tersedia.
 */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'downstream', '.gitlab-ci.yml');
const SAMPLE = path.join(ROOT, 'test', 'fixtures', 'downstream', 'samples', 'generated-jobs.yml');

function python(args, input) {
  return spawnSync('python3', [path.join(ROOT, 'ci_preview.py'), ...args], { encoding: 'utf-8', input });
}

const pythonOk = (() => {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf-8' });
  return probe.status === 0;
})();

// Bahasa default suite utama: Indonesia (assert teks UI berbahasa Indonesia).
function loadCiData(extraArgs, lang) {
  const uiLang = lang || 'id';
  const out = python([FIXTURE, '--json', '--lang=' + uiLang, ...(extraArgs || [])]);
  if (out.status !== 0) throw new Error('engine gagal: ' + out.stderr);
  const data = JSON.parse(out.stdout);
  data.ui_lang = uiLang; // di-inject host (extension.js refreshWebview)
  return data;
}

function simulate(scenario, extraArgs, lang) {
  const out = python([FIXTURE, '--simulate', '--scenario-json', '-', '--lang=' + (lang || 'id'), ...(extraArgs || [])], JSON.stringify(scenario));
  if (out.status !== 0) throw new Error('simulasi gagal: ' + out.stderr);
  return JSON.parse(out.stdout);
}

function openWebview(ciData) {
  let html = fs.readFileSync(path.join(ROOT, 'webview.html'), 'utf-8');
  const dagre = fs.readFileSync(path.join(ROOT, 'vendor', 'dagre.min.js'), 'utf-8');
  const data = JSON.stringify(ciData).replace(/<\/script>/gi, '<\\/script>');
  html = html.replace('__DAGRE_LIB__', () => dagre).replace('__CI_DATA__', () => data);

  const posted = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e && e.message ? e.message : e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      let state = null;
      window.acquireVsCodeApi = () => ({
        postMessage: (m) => posted.push(m),
        getState: () => state,
        setState: (s) => { state = s; },
      });
    },
  });
  return { window: dom.window, document: dom.window.document, posted, errors };
}

function sendSimulation(win, data) {
  win.dispatchEvent(new win.MessageEvent('message', { data: Object.assign({ command: 'simulationResult' }, data) }));
}

beforeAll(() => {
  execFileSync('node', [path.join(ROOT, 'scripts', 'build-webview.js')], { stdio: 'ignore' });
});

describe.skipIf(!pythonOk)('webview: pipeline downstream', () => {
  it('menampilkan badge, panel child, dan kartu bridge tanpa error script', () => {
    const { document, errors } = openWebview(loadCiData());
    expect(errors).toEqual([]);

    const badge = document.getElementById('badgeChildren');
    expect(badge.style.display).not.toBe('none');
    expect(badge.textContent).toContain('2 Child');

    const panels = document.querySelectorAll('#downstreamContainer .child-panel');
    expect(panels.length).toBe(2);
    const childPanel = document.querySelector('[data-child-path="run-child"]');
    const names = Array.from(childPanel.querySelectorAll('.job-title')).map((n) => n.textContent.trim());
    expect(names).toEqual(expect.arrayContaining(['unit-test', 'deploy-child']));

    const bridgeCard = Array.from(document.querySelectorAll('#standardContainer .job-card'))
      .find((c) => c.dataset.jobName === 'run-child');
    expect(bridgeCard.textContent).toContain('⤷ child');
  });

  it('child dinamis tanpa contoh tampil sebagai placeholder dengan tombol pilih file', () => {
    const { document, posted } = openWebview(loadCiData());
    const dyn = document.querySelector('[data-child-path="run-dynamic"]');
    expect(dyn.textContent).toContain('dynamic');
    const pick = Array.from(dyn.querySelectorAll('button')).find((b) => b.textContent.includes('Pilih file contoh'));
    expect(pick).toBeTruthy();
    pick.click();
    expect(posted).toContainEqual({ command: 'pickDynamicSample', job: 'run-dynamic' });
  });

  it('child dinamis dengan file contoh dirender sebagai child biasa', () => {
    const data = loadCiData(['--dynamic-child=run-dynamic=' + SAMPLE]);
    expect(data.child_pipelines['run-dynamic'].status).toBe('SAMPLE');
    const { document, errors } = openWebview(data);
    expect(errors).toEqual([]);
    const dyn = document.querySelector('[data-child-path="run-dynamic"]');
    const names = Array.from(dyn.querySelectorAll('.job-title')).map((n) => n.textContent.trim());
    expect(names).toEqual(expect.arrayContaining(['qa-smoke', 'qa-regression']));
    const clear = Array.from(dyn.querySelectorAll('button')).find((b) => b.textContent.includes('Hapus pilihan'));
    expect(clear).toBeTruthy();
  });

  it('hasil simulasi memberi status pada job child dan merangkum pipeline', () => {
    const scenario = { variables: { CI_COMMIT_BRANCH: 'main' }, changed_files: [], exists_files: [] };
    const result = simulate(scenario);
    expect(result.child_pipelines['run-child'].results['unit-test'].status).toBe('RUN');
    expect(result.child_pipelines['run-child'].results['deploy-child'].status).toBe('MANUAL');

    const { window, document, errors } = openWebview(loadCiData());
    sendSimulation(window, result);
    expect(errors).toEqual([]);

    const childPanel = document.querySelector('[data-child-path="run-child"]');
    const badges = Array.from(childPanel.querySelectorAll('.sim-status-badge')).map((b) => b.textContent.trim());
    expect(badges).toEqual(expect.arrayContaining(['RUN', 'MANUAL']));
    expect(childPanel.textContent).toContain('terpicu');
    // Placeholder dinamis tetap berupa catatan (tidak ada job untuk dilabeli).
    expect(document.querySelector('[data-child-path="run-dynamic"]').querySelectorAll('.job-card').length).toBe(0);
  });

  it('klik job child membuka drawer; klik bridge menampilkan rincian downstream', () => {
    const { document } = openWebview(loadCiData());
    const childCard = Array.from(document.querySelectorAll('[data-child-path="run-child"] .job-card'))
      .find((c) => c.textContent.includes('unit-test'));
    childCard.click();
    expect(document.getElementById('jobDrawer').classList.contains('open')).toBe(true);
    expect(document.getElementById('drawerJobTitle').textContent).toBe('unit-test');

    const bridgeCard = Array.from(document.querySelectorAll('#standardContainer .job-card'))
      .find((c) => c.dataset.jobName === 'run-child');
    bridgeCard.click();
    const section = document.getElementById('drawerChildSection');
    expect(section.textContent).toContain('Downstream pipeline');
    expect(section.textContent).toContain('mirror');
  });

  it('mode Detail memuat node pipeline child dan edge triggers', () => {
    const { document, errors } = openWebview(loadCiData());
    document.getElementById('modeDetailBtn').click();
    expect(errors).toEqual([]);
    const types = new Set(Array.from(document.querySelectorAll('#graphContainer .graph-node')).map((n) => n.getAttribute('data-node-type')));
    expect(types.has('child_pipeline')).toBe(true);
    expect(types.has('dynamic_child')).toBe(true);
    const edgeTypes = new Set(Array.from(document.querySelectorAll('#graphContainer .graph-edge')).map((e) => e.getAttribute('data-edge-type')));
    expect(edgeTypes.has('triggers')).toBe(true);
    expect(edgeTypes.has('child_contains')).toBe(true);
    // Panel downstream (mode Standar) disembunyikan di Detail.
    expect(document.getElementById('downstreamContainer').style.display).toBe('none');
  });

  it('mematikan Mode Simulasi membersihkan status child', () => {
    const scenario = { variables: { CI_COMMIT_BRANCH: 'main' }, changed_files: [], exists_files: [] };
    const { window, document } = openWebview(loadCiData());
    sendSimulation(window, simulate(scenario));
    expect(document.querySelectorAll('[data-child-path="run-child"] .sim-status-badge').length).toBeGreaterThan(0);
    const toggle = document.querySelector('.sim-mode-checkbox');
    toggle.checked = true;
    toggle.dispatchEvent(new window.Event('change'));
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change'));
    expect(document.querySelectorAll('[data-child-path="run-child"] .sim-status-badge').length).toBe(0);
  });
});

describe.skipIf(!pythonOk)('webview: English UI (ui_lang = en)', () => {
  const ID_WORDS = /\b(tidak|belum|terpicu|Pilih|Hapus|contoh|Simulasi|Variabel|Tambah|Ringkasan|Alasan|Cari|Standar)\b/;

  it('static labels, downstream panel and sim panel are in English', () => {
    const { document, errors } = openWebview(loadCiData([], 'en'));
    expect(errors).toEqual([]);
    expect(document.getElementById('modeStandardBtn').textContent).toBe('Standard');
    expect(document.getElementById('searchJobs').placeholder).toBe('Search job / node...');
    expect(document.getElementById('minimapBtn').title).toBe('Show/hide minimap');
    const dyn = document.querySelector('[data-child-path="run-dynamic"]');
    const labels = Array.from(dyn.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels.some((t) => t.includes('Choose sample file'))).toBe(true);
    expect(document.getElementById('simPanel').textContent).toContain('Rules Simulation');
    expect(ID_WORDS.test(document.getElementById('downstreamContainer').textContent)).toBe(false);
    expect(ID_WORDS.test(document.getElementById('simPanel').textContent)).toBe(false);
  });

  it('simulation results and child drawer are in English', () => {
    const scenario = { variables: { CI_COMMIT_BRANCH: 'main' }, changed_files: [], exists_files: [] };
    const { window, document, errors } = openWebview(loadCiData([], 'en'));
    sendSimulation(window, simulate(scenario, [], 'en'));
    expect(errors).toEqual([]);
    const childPanel = document.querySelector('[data-child-path="run-child"]');
    expect(childPanel.textContent).toContain('triggered');
    expect(ID_WORDS.test(document.getElementById('downstreamContainer').textContent)).toBe(false);

    const bridgeCard = Array.from(document.querySelectorAll('#standardContainer .job-card'))
      .find((c) => c.dataset.jobName === 'run-child');
    bridgeCard.click();
    const section = document.getElementById('drawerChildSection');
    expect(section.textContent).toContain('Kind');
    expect(ID_WORDS.test(section.textContent)).toBe(false);
  });
});
