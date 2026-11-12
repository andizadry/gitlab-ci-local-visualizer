// @vitest-environment node
/**
 * i18n webview: setiap teks sumber yang dibungkus L('...') harus punya terjemahan Inggris,
 * dan t() memformat placeholder serta mengikuti bahasa aktif.
 */
const fs = require('fs');
const path = require('path');
const i18n = require('../../src/webview/i18n');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCES = ['src/webview/simUI.js', 'src/webview/graphView.js', 'webview.src.html'];

function unescapeJs(s) {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function collectKeys() {
  const keys = new Set();
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    for (const m of src.matchAll(/\bL\('((?:[^'\\]|\\.)*)'/g)) keys.add(unescapeJs(m[1]));
    // Atribut statis yang diterjemahkan saat bootstrap.
    for (const m of src.matchAll(/data-i18n-(?:title|placeholder)\s+(?:title|placeholder)="([^"]*)"/g)) keys.add(m[1]);
    for (const m of src.matchAll(/data-i18n>([^<]*)</g)) keys.add(m[1].trim());
  }
  // graphView MESSAGES diterjemahkan lewat L(MESSAGES[kind]).
  const gv = fs.readFileSync(path.join(ROOT, 'src/webview/graphView.js'), 'utf-8');
  const block = gv.match(/const MESSAGES = \{([\s\S]*?)\};/);
  if (block) for (const m of block[1].matchAll(/:\s*'([^']*)'/g)) keys.add(m[1]);
  // Label status child (diterjemahkan via childStatusLabel()).
  const html = fs.readFileSync(path.join(ROOT, 'webview.src.html'), 'utf-8');
  const labels = html.match(/const CHILD_STATUS_LABEL = \{([\s\S]*?)\};/);
  if (labels) for (const m of labels[1].matchAll(/\[\s*'([^']*)'/g)) keys.add(m[1]);
  return keys;
}

describe('webview i18n', () => {
  afterEach(() => i18n.setLanguage('en'));

  it('every source string has an English translation', () => {
    const keys = collectKeys();
    expect(keys.size).toBeGreaterThan(60);
    const missing = [...keys].filter((k) => k !== 'resolved' && !Object.prototype.hasOwnProperty.call(i18n.EN, k));
    expect(missing).toEqual([]);
  });

  it('formats placeholders and follows the active language', () => {
    i18n.setLanguage('en');
    expect(i18n.t('Simulasi gagal: {0}', 'boom')).toBe('Simulation failed: boom');
    expect(i18n.t('{0} job berubah.', 3)).toBe('3 job(s) changed.');
    expect(i18n.t('teks tanpa terjemahan')).toBe('teks tanpa terjemahan');
    i18n.setLanguage('id');
    expect(i18n.t('Simulasi gagal: {0}', 'boom')).toBe('Simulasi gagal: boom');
    expect(i18n.getLanguage()).toBe('id');
  });

  it('normalizes language codes', () => {
    expect(i18n.setLanguage('id-ID')).toBe('id');
    expect(i18n.setLanguage('en-US')).toBe('en');
    expect(i18n.setLanguage(undefined)).toBe('en');
    expect(i18n.setLanguage('fr')).toBe('en');
  });
});
