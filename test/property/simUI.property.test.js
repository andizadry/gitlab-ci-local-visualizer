/**
 * Property-based test (fast-check) untuk fungsi murni simUI.normalizeScenario.
 * Sifat yang diuji:
 *  - Idempoten: normalize(normalize(x)) == normalize(x).
 *  - Tidak pernah memuat key kosong (setelah trim) pada variables.
 *  - changed_files/exists_files tidak pernah memuat baris kosong (setelah trim).
 *  - Semua value variables berupa string.
 */
// describe/it/expect disediakan global oleh vitest (globals: true).
const fc = require('fast-check');
const path = require('path');
const { normalizeScenario } = require(path.resolve(__dirname, '..', '..', 'src', 'webview', 'simUI.js'));

const arbScenario = fc.record({
  variables: fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.constant(null))),
  changed_files: fc.array(fc.oneof(fc.string(), fc.constant(''), fc.constant('   '))),
  exists_files: fc.array(fc.oneof(fc.string(), fc.constant(''))),
}, { requiredKeys: [] });

describe('normalizeScenario properties', () => {
  it('idempoten', () => {
    fc.assert(fc.property(arbScenario, (s) => {
      const once = normalizeScenario(s);
      const twice = normalizeScenario(once);
      expect(twice).toEqual(once);
    }));
  });

  it('tidak ada key kosong & semua value string', () => {
    fc.assert(fc.property(arbScenario, (s) => {
      const out = normalizeScenario(s);
      for (const k of Object.keys(out.variables)) {
        expect(String(k).trim()).not.toBe('');
        expect(typeof out.variables[k]).toBe('string');
      }
    }));
  });

  it('tidak ada baris file kosong (setelah trim)', () => {
    fc.assert(fc.property(arbScenario, (s) => {
      const out = normalizeScenario(s);
      for (const f of out.changed_files) expect(f.trim()).not.toBe('');
      for (const f of out.exists_files) expect(f.trim()).not.toBe('');
    }));
  });

  it('robust untuk input non-object', () => {
    fc.assert(fc.property(fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.string()), (bad) => {
      const out = normalizeScenario(bad);
      expect(out).toHaveProperty('variables');
      expect(Array.isArray(out.changed_files)).toBe(true);
      expect(Array.isArray(out.exists_files)).toBe(true);
    }));
  });
});
