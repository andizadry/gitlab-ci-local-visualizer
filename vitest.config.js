// Konfigurasi Vitest untuk test modul webview (vanilla CommonJS) + PBT fast-check.
// Environment 'jsdom' agar modul yang menyentuh DOM (graphView/simUI) bisa diuji headless.
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js'],
    globals: true,
    // Modul webview memakai require() CommonJS; biarkan node menyelesaikannya.
    testTimeout: 15000,
  },
});
