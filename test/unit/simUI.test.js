/**
 * Unit test simUI.js — normalizeScenario, setScenario roundtrip, diff & matrix (v2.0.0 #3/#4).
 * Dijalankan di environment jsdom (vitest).
 */
// describe/it/expect/beforeEach disediakan global oleh vitest (globals: true).
const path = require('path');
const simMod = require(path.resolve(__dirname, '..', '..', 'src', 'webview', 'simUI.js'));

function makeSim() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const posted = [];
  const sim = simMod.createSimUI(host, { doc: document, vscode: { postMessage: (m) => posted.push(m) } });
  sim.render({});
  return { sim, host, posted };
}

describe('normalizeScenario', () => {
  it('membuang key kosong & baris file kosong, mempertahankan value', () => {
    const out = simMod.normalizeScenario({
      variables: { A: '1', '  ': 'x', B: 2 },
      changed_files: ['a.js', '', '  ', 'b.js'],
      exists_files: ['Dockerfile'],
    });
    expect(out.variables).toEqual({ A: '1', B: '2' });
    expect(out.changed_files).toEqual(['a.js', 'b.js']);
    expect(out.exists_files).toEqual(['Dockerfile']);
  });

  it('idempoten (memanggil ulang menghasilkan hasil setara)', () => {
    const once = simMod.normalizeScenario({ variables: { X: 'y' }, changed_files: ['f'], exists_files: [] });
    const twice = simMod.normalizeScenario(once);
    expect(twice).toEqual(once);
  });
});

describe('setScenario roundtrip (#4)', () => {
  it('mengisi field bernama, variabel bebas, & daftar file lalu getScenario mengembalikannya', () => {
    const { sim } = makeSim();
    const scen = {
      variables: { CI_COMMIT_BRANCH: 'main', CI_PIPELINE_SOURCE: 'merge_request_event', FOO: 'bar' },
      changed_files: ['src/app.js', 'README.md'],
      exists_files: ['Dockerfile'],
    };
    sim.setScenario(scen);
    const back = sim.getScenario();
    expect(back.variables.CI_COMMIT_BRANCH).toBe('main');
    expect(back.variables.CI_PIPELINE_SOURCE).toBe('merge_request_event');
    expect(back.variables.FOO).toBe('bar');
    expect(back.changed_files).toEqual(['src/app.js', 'README.md']);
    expect(back.exists_files).toEqual(['Dockerfile']);
  });
});

describe('diff & matrix (#3)', () => {
  let ctx;
  beforeEach(() => { ctx = makeSim(); });

  it('takeSnapshot + renderDiff menyorot job yang berubah status', () => {
    const { sim, host } = ctx;
    sim.onSimulationResult({ results: { a: { status: 'RUN' }, b: { status: 'SKIP' }, c: { status: 'RUN' } } });
    sim.takeSnapshot();
    expect(sim.getSnapshot()).toBeTruthy();
    sim.onSimulationResult({ results: { a: { status: 'RUN' }, b: { status: 'RUN' }, c: { status: 'NEVER' } } });
    sim.renderDiff();
    const changed = host.querySelectorAll('.sim-diff-changed');
    expect(changed.length).toBe(2); // b & c berubah
  });

  it('requestMatrix mengirim simulateMatrix dengan 4 preset', () => {
    const { sim, posted } = ctx;
    sim.requestMatrix();
    const msg = posted.filter((m) => m.command === 'simulateMatrix').pop();
    expect(msg).toBeTruthy();
    expect(Array.isArray(msg.scenarios)).toBe(true);
    expect(msg.scenarios.length).toBe(4);
  });

  it('onMatrixResult merender tabel job × preset; blocked→NEVER, error→ERR', () => {
    const { sim, host } = ctx;
    sim.onMatrixResult({ columns: [
      { label: 'push', results: { a: { status: 'RUN' }, b: { status: 'RUN' } } },
      { label: 'mr', results: { a: { status: 'SKIP' }, b: { status: 'MANUAL' } } },
      { label: 'tag', pipeline_created: false, results: { a: {}, b: {} } },
      { label: 'sched', error: 'boom' },
    ] });
    const table = host.querySelector('.sim-matrix-table');
    expect(table).toBeTruthy();
    expect(host.querySelectorAll('.sim-matrix-table thead th').length).toBe(5); // Job + 4 kolom
    expect(host.querySelectorAll('.sim-matrix-table tbody tr').length).toBe(2); // a, b
    const cells = Array.from(host.querySelectorAll('.sim-matrix-cell')).map((c) => c.textContent);
    expect(cells).toContain('NEVER');
    expect(cells).toContain('ERR');
  });
});
