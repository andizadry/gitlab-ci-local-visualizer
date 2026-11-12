# GitLab CI Local Visualizer (100% Offline) — Bahasa Indonesia

Extension & CLI untuk mem-preview, me-resolve include, memvisualisasikan pipeline, dan **mensimulasikan rules** GitLab CI secara **100% offline** — tanpa koneksi internet, tanpa push ke remote, tanpa GitLab Runner.

Dibuat oleh **andizadry**. Versi: **2.2.1**. English: `README.md`.

> Catatan: seluruh path, nama repo, dan variabel pada dokumen ini hanyalah **contoh dummy**. Ganti dengan milik Anda sendiri.

---

## Daftar Isi
- [Baru di v2.2.0](#baru-di-v220)
- [Baru di v2.1.1](#baru-di-v211)
- [Baru di v2.1.0](#baru-di-v210)
- [Pipeline Downstream (Parent-Child, Multi-Project, Dynamic)](#pipeline-downstream-parent-child-multi-project-dynamic)
- [Baru di v2.0.0](#baru-di-v200)
- [Fitur Utama](#fitur-utama)
- [Instalasi](#instalasi)
- [Cara Pakai di Kiro / VS Code](#cara-pakai-di-kiro--vs-code)
- [Mode Tampilan: Standar & Detail](#mode-tampilan-standar--detail)
- [Interaksi Graph (Mode Detail)](#interaksi-graph-mode-detail)
- [Simulator Rules / Kondisi](#simulator-rules--kondisi)
- [Diagnostics & CodeLens](#diagnostics--codelens)
- [Export](#export)
- [CLI (Terminal)](#cli-terminal)
- [Konfigurasi (config.json)](#konfigurasi-configjson)
- [Catatan Lingkungan (WSL/Windows)](#catatan-lingkungan-wslwindows)
- [Pengujian](#pengujian)
- [Arsitektur Singkat](#arsitektur-singkat)

---

## Baru di v2.2.0

- **Dua bahasa (English / Bahasa Indonesia)** — UI visualizer, pesan engine (diagnostics, alasan simulasi, status include/child), CodeLens, dialog, dan judul setting/perintah. Atur lewat setting `gitlabCiLocal.language`: `auto` (default, ikut bahasa editor), `en`, atau `id`. Mengganti setting langsung me-render ulang visualizer.
- **Konfigurasi include lewat Settings** — `gitlabCiLocal.searchRoots` dan `gitlabCiLocal.projectMappings`, jadi tidak perlu mengedit `config.json` di folder extension. Konfigurasi juga bisa ditaruh di `~/.config/gitlab-ci-local/config.json` (atau path di env `GITLAB_CI_LOCAL_CONFIG`).
- **VSIX bersih** — paket `.vsix` selalu membawa `config.json` kosong (tidak ada path pribadi yang ikut terbawa saat dibagikan).
- **Pesan jelas bila PyYAML belum terpasang** — engine menampilkan cara install (`pip install pyyaml` / `sudo apt install python3-yaml`).
- CLI: opsi baru `--lang en|id` (default `en`, atau env `GITLAB_CI_LOCAL_LANG`) dan `--config-json '<json>'`.
- Panduan instalasi untuk pengguna baru: `INSTALL.md` (ikut dalam paket extension).

---

## Baru di v2.1.1

- **Variabel predefined di `include`** — `${CI_PROJECT_PATH}`, `CI_PROJECT_NAME`, `CI_PROJECT_NAMESPACE`, `CI_PROJECT_ROOT_NAMESPACE`, `CI_PROJECT_PATH_SLUG`, `CI_SERVER_HOST`/`CI_SERVER_FQDN` kini diekspansi (diambil dari `remote.origin.url` di `.git/config`, fallback: path repo relatif terhadap `search_roots`). Variabel lain yang tak diketahui offline disebutkan namanya pada status include.
- **`include:project` tanpa config** — project dicari juga di struktur folder group (`<leluhur>/<group/subgroup/project>`), jadi tetap ketemu walau `project_mappings` usang (mis. folder repo diganti nama).
- **Lebih cepat** — pencarian mendalam di `search_roots` hanya dipakai bila cara murah gagal, dan melewati folder berat (`node_modules`, `.terraform`, `vendor`, dll).

---

## Baru di v2.1.0

- **Parent-child pipeline** (`trigger:include`) — child di-resolve dan ditampilkan sebagai sub-graph/panel, disimulasikan dengan variabel yang di-forward sesuai aturan GitLab.
- **Multi-project pipeline** (`trigger:project`) — project downstream dicari lewat `project_mappings`/`search_roots`.
- **Child dinamis** (`trigger:include:artifact`) — placeholder bila isinya belum diketahui, atau pakai **file contoh** (autodetect, setting, atau tombol *Pilih file contoh…*).
- **Nesting** hingga batas GitLab (dua level child), deteksi siklus, dan `strategy: mirror|depend`.
- **CI/CD inputs** — header `spec:inputs`, `include:inputs`, `trigger:include:inputs`, interpolasi `$[[ inputs.x | fungsi ]]` dengan validasi tipe/options/regex.
- **`include:rules`** — file yang tidak ikut di-include pada skenario tertentu membuat job-nya berstatus `NEVER`.
- **`workflow:rules:variables`**, **`extends`** (hash di-merge, bisa ke job biasa), **`default:`** + `inherit:default`, dan **`!reference`** kini dihitung dalam simulasi.
- **Validasi keyword terbaru** di panel Problems: keyword tak dikenal (dengan saran ejaan), `rules` + `only/except`, `needs` ke stage yang lebih akhir, keyword terlarang pada trigger job, dan keyword global usang.
- **Perbaikan**: `when: manual|delayed` pada level job sekarang diperhitungkan walau tanpa `rules`; `.pre`/`.post` tidak lagi dilaporkan sebagai stage tak terdaftar; include `remote`/`template` ditandai informasi (bukan error); keyword global usang (`image:`, `cache:` di level atas) tidak lagi salah terbaca sebagai job.

---

## Pipeline Downstream (Parent-Child, Multi-Project, Dynamic)

Job dengan `trigger:` (bridge job) menampilkan pipeline downstream-nya:

| Mode | Tampilan |
|------|----------|
| **Standar** | Badge `⤷ child` pada kartu bridge + panel **Downstream pipelines** berisi kolom stage child (bertingkat untuk nested). Klik judul panel untuk rincian. |
| **Detail** | Node `child pipeline` (segi delapan magenta) / `dynamic child` (emas, putus-putus), edge `triggers` dari bridge job, dan job child (`cjob:`) lengkap dengan `needs` antar job child. Klik node untuk drawer rincian. |

**Aturan simulasi** (mengikuti dokumentasi GitLab):
- Bridge `NEVER`/`SKIP` → child **tidak terpicu**. Bridge `MANUAL`/`DELAYED` → child dihitung sebagai *terpicu setelah manual/delayed*.
- Variabel global dan variabel bridge job **di-forward** secara default (`forward.yaml_variables: true`); `inherit:variables` dihormati. *Pipeline variables* (input skenario non-`CI_*`) hanya diteruskan bila `forward.pipeline_variables: true`. Variabel yang diteruskan tidak diteruskan ulang ke nested kecuali bridge nested ikut memakai `forward`.
- Child dalam project yang sama mendapat `CI_PIPELINE_SOURCE=parent_pipeline`; multi-project mendapat `CI_PIPELINE_SOURCE=pipeline` dengan branch downstream (`trigger:branch`, default: `CI_DEFAULT_BRANCH` atau `main`). Daftar file `changes`/`exists` milik parent **tidak** berlaku pada project lain.
- `workflow:rules` di dalam child dievaluasi; bila memblok, seluruh job child `NEVER`.
- Batas GitLab: maksimal **dua level** child (parent → child → grandchild); lebih dari itu ditandai error `child-depth`. Siklus ditandai `child-cycle`.

**Child dinamis (artifact)** — isi `generated-pipeline.yml` baru ada saat runtime, jadi engine mencari **file contoh** dengan urutan:
1. Setting `gitlabCiLocal.dynamicChildren` (atau argumen CLI `--dynamic-child=KUNCI=PATH`).
2. `config.json` → `dynamic_children`.
3. Autodetect: `<folder CI>/<artifact>`, `<folder CI>/.ci-samples/<nama artifact>`, atau `.ci-samples/<nama bridge job>.yml` (naik hingga root repo).

`KUNCI` boleh nama **bridge job**, nama **artifact**, atau nama **job generator**; path relatif dihitung dari folder file CI yang memuat bridge job. Tanpa file contoh, node tampil sebagai *placeholder* beserta petunjuknya. Di UI, tombol **📂 Pilih file contoh…** menyimpan pemetaan ke setting workspace, dan **✖ Hapus pilihan** menghapusnya.

```jsonc
// settings.json (contoh dummy)
{
  "gitlabCiLocal.dynamicChildren": {
    "trigger-generated": "samples/generated-pipeline.yml"
  }
}
```

---

## Baru di v2.0.0

- **Diagnostics / linter** — masalah pipeline tampil di panel **Problems** VS Code: `needs` ke job yang tidak ada, `extends` template hilang, stage tak terdaftar, `needs` melingkar (cycle), include tak terselesaikan. Klik entri untuk lompat ke baris sumber.
- **Rules Trace (explainer)** — di drawer job, lihat evaluasi rules **langkah demi langkah**: tiap `rule[i]` beserta hasil klausa `if`/`changes`/`exists`, penanda rule mana yang **efektif**, dan `when` hasilnya.
- **Simulator Diff & Matrix** — ambil **Snapshot** hasil simulasi, ubah skenario, lalu **Diff** untuk menyorot job yang berubah status; atau **Run Preset Matrix** untuk tabel `job × preset` sekaligus.
- **Copy Resolved Job** — salin definisi job yang sudah **ter-merge** (`extends` + `variables`) sebagai YAML-ish ke clipboard.
- **Minimap** — panel overview untuk graph besar; klik minimap untuk melompat ke area.
- **Arah layout LR/TB** — ganti orientasi graph (kiri→kanan atau atas→bawah).
- **Export PNG** — selain SVG & DOT, unduh graph sebagai **PNG**.
- **Smart search** — filter dengan sintaks `tag:`, `stage:`, `status:` (mis. `status:run`).
- **CodeLens** — anotasi di atas tiap job pada file YAML: stage & jumlah `needs` + aksi buka visualizer terfokus ke job itu.
- **Persist state** — mode (Standar/Detail), arah layout, posisi node yang di-drag, filter aktif, skenario, minimap, dan kata kunci pencarian diingat antar sesi.
- **Sintaks GitLab modern** — dukungan `!reference`, `include:component` (ditandai sebagai komponen eksternal), dan penyimpanan `parallel`/`parallel:matrix`.

---

## Fitur Utama

- **Preview pipeline offline** — resolve semua `include: local/file/project` secara rekursif dari repo lokal.
- **Dua mode tampilan**:
  - **Standar** — kolom per stage berisi kartu job (bersih, ringkas, mirip tampilan pipeline GitLab).
  - **Detail** — graph dependency interaktif (DAG) antar file, template, job, dan stage.
- **Graph dependency interaktif** dengan node yang bisa **ditarik (drag)**, **zoom-to-cursor**, **pan**, dan **fit-to-screen**.
- **Filter relasi (edge)** per tipe: `includes`, `defines_template`, `defines_job`, `extends`, `needs`, `stage_contains` — mis. centang `includes` saja untuk memantau include.
- **Behind / Ahead** — dari sebuah node lihat dependency (upstream) dan dependents (downstream)-nya, bisa diklik untuk navigasi.
- **Klik kanan (context menu)** pada node: **Open file**, **Focus & highlight**, **Copy path**. (Klik kiri hanya memilih/menyorot — tidak langsung membuka file.)
- **Simulator Rules** — masukkan variabel CI (mis. `CI_COMMIT_BRANCH`, `CI_PIPELINE_SOURCE`) lalu lihat job mana yang **RUN / SKIP / MANUAL / DELAYED / NEVER**, lengkap alasan & `when` efektif. Kompatibel dengan `rules`, `only/except` legacy, dan `workflow:rules`.
- **Diagnostics** — validasi pipeline (needs/extends/stage/cycle/include) langsung ke panel **Problems**.
- **Rules Trace** — penjelasan evaluasi rules per job, langkah demi langkah.
- **Simulator Diff & Matrix** — bandingkan dua skenario, atau lihat tabel `job × preset`.
- **CodeLens** di file YAML — info stage/needs + aksi buka visualizer terfokus per job.
- **Minimap** & **arah layout LR/TB** untuk graph besar.
- **Search cepat & smart filter** — di mode Standar memfilter kartu, di mode Detail menyorot node; dukung `tag:`/`stage:`/`status:`.
- **Export** — salin graph sebagai **SVG** atau **Graphviz DOT**, atau unduh **PNG**; plus **Copy Resolved Job** (YAML ter-merge).
- **Jump to source** — buka file YAML sumber pada baris yang tepat (job, template, include).
- **Merged YAML viewer** — lihat hasil merge seluruh include.
- **Persist state** — preferensi tampilan & skenario diingat antar sesi.
- **Live reload** — tampilan menyegar otomatis saat file YAML disimpan.
- **100% offline** — seluruh library (dagre) di-bundle lokal; patuh Content Security Policy webview; tidak ada permintaan jaringan.

---

## Instalasi

Extension dikemas sebagai `.vsix` (panduan lengkap langkah demi langkah: `INSTALL.md`). Install dari Kiro/VS Code:

```bash
kiro --install-extension gitlab-ci-local-visualizer-2.2.1.vsix --force
# atau di VS Code:
code --install-extension gitlab-ci-local-visualizer-2.2.1.vsix --force
```

Setelah install, **reload window** (`Ctrl+Shift+P` -> "Developer: Reload Window").

Prasyarat: hanya **Python 3** (PyYAML sudah dibundel) yang harus dapat dipanggil di lingkungan tempat file berada (native atau di dalam WSL). Extension otomatis mendeteksi bila file berada di WSL dan menjalankan engine lewat `wsl`.

---

## Cara Pakai di Kiro / VS Code

1. Buka file GitLab CI (mis. `.gitlab-ci.yml`).
2. Buka visualizer lewat salah satu cara:
   - Klik ikon graph/preview di pojok kanan atas tab editor.
   - `Ctrl+Shift+P` -> **GitLab CI Local: Open Visualizer**.
   - Klik kanan tab editor / file di Explorer -> **GitLab CI Local: Open Visualizer**.
3. Panel visualizer terbuka di samping editor.

Tersedia 3 tab: **Dependency Graph** (Standar/Detail), **File Hierarchy**, **Merged YAML**.

---

## Mode Tampilan: Standar & Detail

Di tab **Dependency Graph** ada segmented switch **Standar | Detail**:

- **Standar** (default): kolom per stage. Tiap kartu job menampilkan nama, badge `extends`/tags/`manual`, dan file sumber. Klik kartu -> drawer detail. Saat simulasi aktif, kartu diberi warna & badge status.
- **Detail**: graph dependency interaktif penuh (lihat di bawah).

---

## Interaksi Graph (Mode Detail)

- **Klik kiri node** -> pilih & sorot node + tetangganya (highlight). **Tidak** membuka file.
- **Klik kanan node** -> context menu:
  - **Open file** — buka file sumber node pada baris yang tepat.
  - **Focus & highlight** — sorot node & relasinya.
  - **Copy path** — salin path file ke clipboard.
- **Drag node** — tarik node untuk mengatur posisi; garis relasi mengikuti.
- **Zoom** — scroll mouse (zoom ke arah kursor), atau tombol `+` / `-`.
- **Fit** (fit-to-screen) — paskan seluruh graph ke layar. **Reset** — kembalikan tampilan.
- **Pan** — drag area kosong untuk menggeser.
- **Filter relasi** — centang/hilangkan tipe edge yang ingin ditampilkan.
- **Search** — ketik di kotak cari; node yang cocok disorot, sisanya diredupkan.
- **Legend** — keterangan warna/bentuk node & gaya garis tiap tipe relasi.

Warna & tebal garis dibedakan per tipe relasi agar tidak "nyaru":
`includes` (biru), `needs` (hijau tebal), `extends` (ungu/pink), `defines_job` (oranye), `defines_template` (ungu), `stage_contains` (cyan), relasi tak-terselesaikan (merah putus-putus).

---

## Simulator Rules / Kondisi

Panel **Simulasi Rules** ada di atas area graph.

1. Isi variabel CI: field bernama (`CI_COMMIT_BRANCH`, `CI_COMMIT_TAG`, `CI_COMMIT_REF_NAME`, `CI_DEFAULT_BRANCH`, `CI_MERGE_REQUEST_*`), dropdown `CI_PIPELINE_SOURCE`, plus pasangan key-value bebas.
2. Opsional: daftar file **changed** dan **exists** (untuk `rules:changes` / `rules:exists`).
3. Pilih **Preset** cepat: `push to main`, `merge request`, `tag pipeline`, `scheduled`.
4. Aktifkan **Mode Simulasi** atau klik **Evaluate**.

Hasil per job: **RUN / SKIP / MANUAL / DELAYED / NEVER** (badge pada node di Detail, dan pada kartu di Standar), dengan **alasan** (rule ke berapa yang match + ekspresinya) dan **`when` efektif**.

**Rules Trace (v2.0.0):** buka drawer job (klik kartu / node) untuk melihat evaluasi rules langkah demi langkah — tiap `rule[i]`, hasil klausa `if`/`changes`/`exists`, penanda **EFFECTIVE**, dan rule yang tak sempat dievaluasi (`not reached`).

**Diff & Matrix (v2.0.0):** di panel simulasi:
- **Snapshot** → simpan hasil saat ini; ubah skenario; **Diff vs Snapshot** menyorot job yang berubah status (`A → B`), job baru, atau job hilang.
- **Run Preset Matrix** → jalankan seluruh preset sekaligus dan tampilkan tabel `job × preset` (sel diblok workflow → `NEVER`, error → `ERR`).

Semantik yang didukung (kompatibel GitLab SaaS terkini):
- Operator `==`, `!=`, `=~`, `!~`, `&&`, `||`, tanda kurung; regex (`/pola/`, flag `i`); `null`; string kosong; truthiness `$VAR`.
- `rules` first-match; `when`: `on_success`/`on_failure`/`always`/`manual`/`delayed`/`never`.
- `workflow:rules` (bila memblok, seluruh job berstatus NEVER).
- `only/except` legacy (refs, variables, changes).
- Precedence variabel: input Skenario > `variables` job > `variables` global.

> Catatan: `changes`/`exists` dievaluasi terhadap daftar file yang Anda tentukan (karena berjalan offline tanpa git diff).

---

## Diagnostics & CodeLens

**Diagnostics** — saat visualizer terbuka (atau file YAML disimpan), engine memvalidasi pipeline dan menampilkan masalah di panel **Problems**:
- `needs` menunjuk job yang tidak ada.
- `extends` menunjuk template yang hilang.
- job memakai stage yang tak terdaftar di `stages`.
- `needs` melingkar (cycle terdeteksi).
- `include` yang tidak dapat diresolve; `include:component` ditandai sebagai komponen eksternal (info, bukan error).

Klik entri di panel Problems untuk lompat ke baris sumber yang tepat.

**CodeLens** — pada file `.gitlab-ci.yml`, tiap job diberi anotasi ringkas (stage & jumlah `needs`) beserta aksi **buka visualizer** langsung terfokus ke job tersebut.

---

## Export

Di mode Detail, toolbar menyediakan:
- **SVG** — menyalin markup SVG graph ke clipboard (tempel ke file `.svg`).
- **PNG** — merender graph ke kanvas lalu mengunduhnya sebagai `.png`.
- **DOT** — menyalin representasi **Graphviz DOT** ke clipboard (bisa dirender dengan `dot -Tpng`).
- **Copy Resolved Job** — dari drawer job, salin definisi ter-merge (`extends` + `variables`) sebagai YAML-ish ke clipboard.

---

## CLI (Terminal)

Engine Python bisa dijalankan langsung. Ganti `path/ke/.gitlab-ci.yml` dengan file Anda.

```bash
# Preview ringkas
python3 ci_preview.py path/ke/.gitlab-ci.yml

# Daftar file include
python3 ci_preview.py path/ke/.gitlab-ci.yml --files

# Inspeksi satu job
python3 ci_preview.py path/ke/.gitlab-ci.yml --job build

# Output analisis penuh (JSON) — dipakai webview
python3 ci_preview.py path/ke/.gitlab-ci.yml --json

# Simpan merged YAML
python3 ci_preview.py path/ke/.gitlab-ci.yml -o /tmp/merged-ci.yaml

# Simulasi rules (JSON hasil per job)
python3 ci_preview.py path/ke/.gitlab-ci.yml --simulate \
  --var CI_COMMIT_BRANCH=main --var CI_PIPELINE_SOURCE=push \
  --changed-file src/app.py

# atau kirim skenario via JSON (stdin)
echo '{"variables":{"CI_COMMIT_BRANCH":"main"},"changed_files":[],"exists_files":[]}' \
  | python3 ci_preview.py path/ke/.gitlab-ci.yml --simulate --scenario-json -

# petakan child pipeline dinamis (artifact) ke file YAML contoh (repeatable)
python3 ci_preview.py path/ke/.gitlab-ci.yml --json \
  --dynamic-child=trigger-generated=samples/generated-pipeline.yml
```

Keluaran `--json` memuat `child_pipelines` (pohon downstream) dan keluaran `--simulate` memuat `child_pipelines` berisi hasil simulasi tiap pipeline downstream.

---

## Konfigurasi (config.json)

Mengatur direktori pencarian repo lokal untuk resolve include. Ada tiga sumber, digabung dengan prioritas (paling atas menang / dicari lebih dulu):

1. **Settings editor** — `gitlabCiLocal.searchRoots` dan `gitlabCiLocal.projectMappings` (cara paling mudah).
2. **File user** — `~/.config/gitlab-ci-local/config.json` (atau path di env `GITLAB_CI_LOCAL_CONFIG`), format sama dengan contoh di bawah.
3. **`config.json` di samping `ci_preview.py`** — untuk pemakaian CLI dari clone repo.

Contoh settings (`settings.json`, data dummy):

```json
{
  "gitlabCiLocal.language": "auto",
  "gitlabCiLocal.searchRoots": ["/home/me/repos"],
  "gitlabCiLocal.projectMappings": {
    "my-group/ci-templates": "/home/me/repos/ci-templates"
  }
}
```

Untuk `config.json` di folder engine, salin dulu templatenya, lalu isi dengan path Anda:

```bash
cp config.example.json config.json
```

`config.json` **tidak** ikut di-commit (ada di `.gitignore`) karena berisi path repo pribadi. **Contoh dummy** isinya:

```json
{
  "search_roots": [
    "/path/to/your/repos/app-frontend",
    "/path/to/your/repos/app-backend",
    "/path/to/your/workspace"
  ],
  "project_mappings": {
    "group/subgroup/shared-ci": "/path/to/your/repos/shared-ci",
    "group/downstream-app": "/path/to/your/repos/downstream-app"
  },
  "dynamic_children": {
    "trigger-generated": "samples/generated-pipeline.yml"
  }
}
```

Tambahkan path repo baru di `search_roots` bila diperlukan. `project_mappings` juga dipakai untuk menemukan project downstream (`trigger:project`), dan `dynamic_children` memetakan child dinamis ke file contoh (lihat bagian *Pipeline Downstream*).

Setting VS Code opsional:
- `gitlabCiLocal.language` — bahasa UI & pesan: `auto` (ikut editor), `en`, `id`.
- `gitlabCiLocal.searchRoots` / `gitlabCiLocal.projectMappings` — sama dengan `search_roots` / `project_mappings` di atas.
- `gitlabCiLocal.wslScriptPath` — path absolut `ci_preview.py` di dalam WSL (auto-detect bila kosong).
- `gitlabCiLocal.pythonPath` — override interpreter Python.
- `gitlabCiLocal.dynamicChildren` — pemetaan child dinamis → file YAML contoh (lihat *Pipeline Downstream*).

---

## Catatan Lingkungan (WSL/Windows)

Extension mendeteksi otomatis bila file berada di WSL (path UNC `\\wsl.localhost\<distro>\...`) dan menjalankan engine Python di dalam distro tersebut, sekaligus mengonversi path dua arah (Windows UNC <-> Linux) agar **Open file** membuka file yang benar. Berjalan pula secara native di Linux/macOS.

---

## Pengujian

Modul UI diuji dengan **Vitest** (jsdom) + **fast-check** (property-based). Engine Python diuji dengan **pytest** + **Hypothesis**. Semua data uji adalah fixture dummy.

```bash
# Test JS: unit + property + integrasi webview (jsdom)
npm test
npm run test:unit
npm run test:property
npm run test:integration   # engine Python -> webview.html di jsdom (dilewati bila python3 + PyYAML tak ada)

# Test Python (otomatis membuat virtualenv .venv-test bila belum ada;
# diperlukan di distro dengan Python "externally managed")
npm run test:python
# atau langsung:
bash scripts/run-py-tests.sh -q
```

Cakupan:
- **UI**: `normalizeScenario`, diff/matrix simulator, minimap, `computeNeighbors`, tipe node/edge downstream, dan alur end-to-end panel downstream (badge, panel child, placeholder dinamis, drawer, graf Detail, status simulasi).
- **Engine**: parent-child/multi-project/dynamic (forward variabel, gating bridge, nesting, siklus, sample), inputs & interpolasi, `extends`/`default`/`!reference`, `include:rules`, `workflow:rules:variables`, validasi keyword, plus properti murni (round-trip `parse`/`unparse`, totalitas `when_to_status`, kontrak `match_paths`, prioritas `when`).

---

## Arsitektur Singkat

- `ci_preview.py` — parser & resolver pipeline; menghasilkan `jobs`, `templates`, `stages`, `file_trace`, `deep_graph`, `merged_yaml`, `diagnostics`, `child_pipelines`; menggabungkan `extends`/`default`/`!reference`, meresolve `trigger` (child, multi-project, dynamic), `include:component|remote|template` (ditandai eksternal), dan `parallel`; plus mode `--simulate`.
- `rules_evaluator.py` — evaluator ekspresi rules (tokenizer + parser + evaluator, tanpa `eval()`), `only/except`, `workflow:rules` (+`variables`), resolusi variabel, `include:rules`, `explain_rules` (trace langkah demi langkah), dan simulasi pipeline downstream.
- `ci_inputs.py` — header `spec:inputs`, validasi input, dan interpolasi `$[[ ... ]]` (murni, tanpa I/O).
- `ci_keywords.py` — daftar keyword GitLab terbaru dan validasi struktur job/global (murni, tanpa I/O).
- `extension.js` — host VS Code: menjalankan engine (native/WSL), inject data & library ke webview, menangani pesan `openFile`/`refresh`/`simulate`/`simulateMatrix`/`copyText`, publikasi **Diagnostics**, dan **CodeLens** provider.
- `src/webview/*.js` — modul UI murni (graphModelBuilder, layoutEngine [dagre], graphView [termasuk minimap & arah layout], edgeFilter, highlight, interaction, simUI [trace/diff/matrix], openFileMsg) yang dibundel inline ke `webview.html` saat build (patuh CSP, 100% offline).
- `scripts/build-webview.js` — membundel modul webview menjadi `webview.html`.
- `test/` — Vitest (unit + property) untuk modul UI; Hypothesis (pytest) untuk engine rules.

Build ulang webview: `npm run build`.