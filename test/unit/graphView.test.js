/**
 * Unit test graphView.js — minimap (v2.0.0 #8) & computeNeighbors (behind/ahead).
 */
// describe/it/expect disediakan global oleh vitest (globals: true).
const path = require('path');
const gvMod = require(path.resolve(__dirname, '..', '..', 'src', 'webview', 'graphView.js'));
const gmb = require(path.resolve(__dirname, '..', '..', 'src', 'webview', 'graphModelBuilder.js'));

const DEEP = {
  nodes: [
    { id: 'job:a', label: 'a', type: 'job' },
    { id: 'job:b', label: 'b', type: 'job' },
    { id: 'job:c', label: 'c', type: 'job' },
  ],
  edges: [
    { id: 'e1', source: 'job:a', target: 'job:b', type: 'needs' },
    { id: 'e2', source: 'job:b', target: 'job:c', type: 'needs' },
  ],
};

function buildModel() {
  const fn = gmb.build || gmb.buildGraphModel || gmb.default;
  return fn(DEEP);
}

describe('minimap (#8)', () => {
  it('setMinimapEnabled(true) membuat DOM minimap dengan node rects + view rect', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });

    const gv = gvMod.createGraphView(container, { doc: document });
    gv.render(buildModel());
    expect(container.querySelector('svg')).toBeTruthy();

    expect(gv.setMinimapEnabled(true)).toBe(true);
    expect(container.querySelector('.graph-minimap')).toBeTruthy();
    expect(container.querySelector('.graph-minimap-view')).toBeTruthy();
    // 3 node + 1 kotak viewport.
    expect(container.querySelectorAll('.graph-minimap-svg rect').length).toBeGreaterThanOrEqual(4);

    expect(gv.setMinimapEnabled(false)).toBe(false);
    expect(container.querySelector('.graph-minimap')).toBeNull();
  });

  it('minimap bisa di-drag (mousedown pada svg lalu mousemove menggeser viewport)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });

    const gv = gvMod.createGraphView(container, { doc: document });
    gv.render(buildModel());
    gv.setMinimapEnabled(true);
    const mmSvg = container.querySelector('.graph-minimap-svg');
    expect(mmSvg).toBeTruthy();
    // jsdom getBoundingClientRect default 0-size; stub agar konversi koordinat bekerja.
    mmSvg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 180, height: 120 });

    const before = gv.getOffset();
    // Tekan lalu geser: harus memicu pan (offset berubah), bukan hanya tap.
    mmSvg.dispatchEvent(new window.MouseEvent('mousedown', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 140, clientY: 90, bubbles: true }));
    const during = gv.getOffset();
    document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));

    expect(during.x !== before.x || during.y !== before.y).toBe(true);

    // Setelah mouseup, mousemove tak lagi menggeser (drag berhenti).
    const afterUp = gv.getOffset();
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 10, clientY: 10, bubbles: true }));
    expect(gv.getOffset()).toEqual(afterUp);
  });
});

describe('focus & highlight (bayangan samar, bukan hilang)', () => {
  function setup() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    const gv = gvMod.createGraphView(container, { doc: document });
    gv.render(buildModel());
    return { gv, container };
  }

  function classesOf(container, id) {
    const n = container.querySelector('[data-node-id="' + id + '"]');
    return n ? Array.from(n.classList) : [];
  }

  it('pilih node → node terpilih+tetangga highlighted, sisanya dimmed (tetap tampil, tak hilang)', () => {
    const { gv, container } = setup();
    // Model a-b-c: pilih a → a & b highlighted, c dimmed (bukan hilang).
    gv.selectNode('job:a');
    expect(classesOf(container, 'job:a')).toContain('highlighted');
    expect(classesOf(container, 'job:b')).toContain('highlighted');
    expect(classesOf(container, 'job:c')).toContain('dimmed');
    // Tidak ada node yang disembunyikan total.
    const hiddenNodes = Array.from(container.querySelectorAll('.graph-node'))
      .filter((n) => n.style && n.style.display === 'none');
    expect(hiddenNodes.length).toBe(0);
  });

  it('deselect → semua kelas highlight/dim dibersihkan', () => {
    const { gv, container } = setup();
    gv.selectNode('job:a');
    gv.deselect();
    ['job:a', 'job:b', 'job:c'].forEach((id) => {
      const cls = classesOf(container, id);
      expect(cls).not.toContain('highlighted');
      expect(cls).not.toContain('dimmed');
    });
  });

  it('tidak ada API isolate lagi (fitur dihapus)', () => {
    const { gv } = setup();
    expect(gv.setIsolateMode).toBeUndefined();
    expect(gv.isIsolateMode).toBeUndefined();
  });
});

describe('default zoom-in (initial view)', () => {
  it('graph dibuka dengan skala >= 1 (node langsung detail, tak perlu zoom manual)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    // Viewport kecil relatif graph → fit biasa akan mengecilkan; initialView harus zoom-in.
    Object.defineProperty(container, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });
    const gv = gvMod.createGraphView(container, { doc: document });
    gv.render(buildModel());
    expect(gv.getScale()).toBeGreaterThanOrEqual(1.0);
  });
});

describe('computeNeighbors', () => {
  it('menghitung behind (masuk) & ahead (keluar) untuk sebuah node', () => {
    const n = gvMod.computeNeighbors(DEEP, 'job:b');
    expect(n.behind.map((x) => x.id)).toEqual(['job:a']);
    expect(n.ahead.map((x) => x.id)).toEqual(['job:c']);
  });

  it('aman untuk deepGraph null', () => {
    const n = gvMod.computeNeighbors(null, 'x');
    expect(n).toEqual({ behind: [], ahead: [] });
  });
});

describe('styleForEdgeType (murni)', () => {
  it('mengembalikan salinan gaya & gaya unresolved berbeda', () => {
    const a = gvMod.styleForEdgeType('needs');
    const b = gvMod.styleForEdgeType('needs', true);
    expect(a).toHaveProperty('color');
    expect(b.color).not.toBe(a.color); // unresolved memakai warna khusus
    a.color = '#000000';
    expect(gvMod.styleForEdgeType('needs').color).not.toBe('#000000'); // tak memutasi konstanta
  });
});

describe('tipe node/edge downstream (child / multi-project / dynamic)', () => {
  const edgeFilter = require(path.resolve(__dirname, '..', '..', 'src', 'webview', 'edgeFilter.js'));
  const DOWNSTREAM = {
    nodes: [
      { id: 'job:bridge', label: 'bridge', type: 'job' },
      { id: 'child:bridge', label: 'child pipeline (1 jobs)', type: 'child_pipeline', path: '/x/child.yml', line_number: 1 },
      { id: 'cjob:bridge/unit', label: 'unit', type: 'job' },
      { id: 'job:dyn', label: 'dyn', type: 'job' },
      { id: 'child:dyn', label: 'dynamic child', type: 'dynamic_child' },
    ],
    edges: [
      { source: 'job:bridge', target: 'child:bridge', type: 'triggers' },
      { source: 'child:bridge', target: 'cjob:bridge/unit', type: 'child_contains' },
      { source: 'job:dyn', target: 'child:dyn', type: 'triggers' },
    ],
  };

  it('model builder mempertahankan edge triggers & child_contains dan menghitungnya', () => {
    const fn = gmb.build || gmb.buildGraphModel || gmb.default;
    const model = fn(DOWNSTREAM);
    expect(model.ok).toBe(true);
    expect(model.edges.length).toBe(3);
    expect(model.edgeTypeCounts.triggers).toBe(2);
    expect(model.edgeTypeCounts.child_contains).toBe(1);
  });

  it('filter edge menyediakan kontrol untuk tipe downstream', () => {
    const fn = gmb.build || gmb.buildGraphModel || gmb.default;
    const filters = edgeFilter.deriveFilters(fn(DOWNSTREAM));
    const types = filters.map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(['triggers', 'child_contains']));
    expect(filters.find((f) => f.type === 'triggers').interactive).toBe(true);
  });

  it('graphView memberi bentuk, warna, dan garis putus-putus khusus node downstream', () => {
    const fn = gmb.build || gmb.buildGraphModel || gmb.default;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const gv = gvMod.createGraphView(container, { doc: document });
    gv.render(fn(DOWNSTREAM));

    const child = container.querySelector('[data-node-id="child:bridge"] .node-shape');
    const dyn = container.querySelector('[data-node-id="child:dyn"] .node-shape');
    expect(child.tagName.toLowerCase()).toBe('polygon');           // segi delapan
    expect(child.getAttribute('fill')).toBe(gvMod.NODE_COLORS.child_pipeline);
    expect(dyn.getAttribute('stroke-dasharray')).toBe('5 3');      // child dinamis: garis putus-putus
    expect(dyn.getAttribute('fill')).toBe(gvMod.NODE_COLORS.dynamic_child);

    const trig = container.querySelector('[data-edge-type="triggers"] .edge-path');
    expect(trig.getAttribute('stroke')).toBe(gvMod.EDGE_STYLES.triggers.color);
    expect(container.querySelector('marker[id="arrow-triggers"]')).toBeTruthy();   // marker panah tersedia
  });

  it('legend memuat tipe node & edge baru', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const gv = gvMod.createGraphView(container, { doc: document });
    gv.renderLegend();
    expect(container.querySelector('[data-legend-node-type="child_pipeline"]')).toBeTruthy();
    expect(container.querySelector('[data-legend-node-type="dynamic_child"]')).toBeTruthy();
    expect(container.querySelector('[data-legend-edge-type="triggers"]')).toBeTruthy();
  });
});
