# Panduan Instalasi — GitLab CI Local Visualizer

Panduan ini untuk kamu yang baru pertama kali memasang extension ini di **Kiro** atau **VS Code**.
Semua contoh path di bawah adalah contoh (dummy); sesuaikan dengan komputermu.

---

## 1. Prasyarat

| Kebutuhan | Keterangan |
|---|---|
| Kiro atau VS Code | Versi 1.70 ke atas. |
| Python 3 | Harus ada **di lingkungan tempat file CI kamu berada** (lihat tabel di bawah). |

Library YAML (PyYAML) sudah dibundel di dalam extension, jadi tidak perlu dipasang. Kalau PyYAML kebetulan sudah ada di sistem, itu yang dipakai (sedikit lebih cepat).

Di mana Python harus terpasang:

| File `.gitlab-ci.yml` kamu ada di... | Python 3 dipasang di... | Biasanya |
|---|---|---|
| Linux / macOS | mesin itu sendiri | sudah terpasang |
| WSL, dibuka dari Kiro/VS Code Windows (path `\\wsl.localhost\Ubuntu\...`) | **di dalam distro WSL** (bukan di Windows) | sudah terpasang di Ubuntu |
| Windows (mis. `C:\repos\app`) | Windows | perlu dipasang |

### Cek & pasang Python 3

Linux / WSL (Ubuntu/Debian):

```bash
python3 --version
# kalau belum ada:
sudo apt update && sudo apt install -y python3
```

macOS:

```bash
python3 --version
# kalau belum ada: pasang dari https://www.python.org/downloads/ atau
brew install python
```

Windows: unduh dari https://www.python.org/downloads/, lalu saat install **centang "Add python.exe to PATH"**. Cek di PowerShell:

```powershell
python --version
```

Kalau Python tidak ketemu, extension akan menampilkan notifikasi berisi link download / perintah install dan tombol untuk membuka setting `gitlabCiLocal.pythonPath`.

---

## 2. Dapatkan extension

**Dari marketplace (paling gampang, bila sudah dipublish)** — buka panel **Extensions** (`Ctrl+Shift+X`), cari **GitLab CI Local Visualizer** (publisher `andizadry`), klik **Install**. Kiro mengambil dari Open VSX, VS Code dari Visual Studio Marketplace. Lewati langkah 3.

Atau pakai file `.vsix`, pilih salah satu:

**A. Dikirim langsung (paling gampang)** — minta file `gitlab-ci-local-visualizer-<versi>.vsix` dari pemilik extension, simpan di folder mana saja (mis. `Downloads`).

**B. Build sendiri dari repo** (butuh akses ke repo, plus `git`, `node`, `bash`, `zip`):

```bash
git clone <url-repo-yang-diberikan> gitlab-ci-visualizer
cd gitlab-ci-visualizer
npm install            # sekali saja, untuk build webview & test
node scripts/build-webview.js
bash scripts/package-vsix.sh
# hasil: gitlab-ci-local-visualizer-<versi>.vsix di folder ini
```

---

## 3. Install extension

### Lewat UI (Kiro / VS Code)

1. Buka panel **Extensions** (`Ctrl+Shift+X`).
2. Klik menu `···` di pojok kanan atas panel → **Install from VSIX...**
3. Pilih file `.vsix` tadi.
4. Reload: `Ctrl+Shift+P` → **Developer: Reload Window**.

### Lewat terminal

```bash
# Kiro
kiro --install-extension /path/ke/gitlab-ci-local-visualizer-2.2.1.vsix --force

# VS Code
code --install-extension /path/ke/gitlab-ci-local-visualizer-2.2.1.vsix --force
```

Windows (PowerShell), contoh:

```powershell
kiro --install-extension "$env:USERPROFILE\Downloads\gitlab-ci-local-visualizer-2.2.1.vsix" --force
```

Untuk update ke versi baru, ulangi langkah yang sama dengan file `.vsix` terbaru (opsi `--force` menimpa versi lama), lalu reload window.

---

## 4. Atur bahasa (opsional)

Buka Settings (`Ctrl+,`), cari **GitLab CI Local**, lalu atur **Language**:

- `auto` (default) — ikut bahasa editor; Indonesia kalau editor berbahasa Indonesia, selain itu Inggris.
- `en` — English.
- `id` — Bahasa Indonesia.

Atau di `settings.json`:

```json
{
  "gitlabCiLocal.language": "id"
}
```

---

## 5. Atur lokasi repo untuk `include:project` (opsional, tapi disarankan)

`include: local` langsung jalan tanpa konfigurasi. Untuk `include: project` (template dari repo lain), extension perlu tahu di mana repo-repo itu ada di komputermu.

Contoh susunan folder (dummy):

```
/home/me/repos/
├── my-group/ci-templates/      <- project "my-group/ci-templates"
└── my-group/backend-app/       <- repo yang .gitlab-ci.yml-nya kamu buka
```

Tambahkan di `settings.json`:

```json
{
  "gitlabCiLocal.searchRoots": ["/home/me/repos"],
  "gitlabCiLocal.projectMappings": {
    "my-group/ci-templates": "/home/me/repos/ci-templates"
  }
}
```

- `searchRoots` — folder induk yang dicari otomatis (urutan = prioritas).
- `projectMappings` — pemetaan eksplisit `path project GitLab` → `folder lokal`, dipakai kalau nama/susunan folder tidak sama dengan path project.
- Kalau file CI ada di **WSL**, tulis path versi Linux (`/home/me/repos`), bukan `\\wsl.localhost\...`.

Alternatif tanpa settings: buat file `~/.config/gitlab-ci-local/config.json` (di lingkungan tempat Python berjalan):

```json
{
  "search_roots": ["/home/me/repos"],
  "project_mappings": {
    "my-group/ci-templates": "/home/me/repos/ci-templates"
  }
}
```

---

## 6. Cara pakai

1. Buka file GitLab CI, mis. `.gitlab-ci.yml`.
2. Klik ikon visualizer di pojok kanan atas tab editor, atau `Ctrl+Shift+P` → **GitLab CI Local: Open Visualizer**.
3. Panel visualizer terbuka di samping editor:
   - **Dependency Graph** — mode *Standard/Standar* (kolom per stage) dan *Detail* (graf interaktif).
   - **Rules Simulation / Simulasi Rules** — isi variabel (mis. `CI_COMMIT_BRANCH=main`), klik **Evaluate** untuk melihat job mana yang jalan.
   - **File Hierarchy** dan **Merged YAML**.
4. Masalah pipeline (needs/extends hilang, keyword salah, dsb.) muncul di panel **Problems**.

Detail fitur lengkap ada di `README.id.md` (Indonesia) dan `README.md` (English).

---

## 7. Troubleshooting

| Gejala | Solusi |
|---|---|
| `Could not find a Python 3 interpreter` | Pasang Python 3 di lingkungan yang benar (lihat tabel Prasyarat). Bisa juga isi setting `gitlabCiLocal.pythonPath` dengan path python. |
| `COULD NOT RESOLVE LOCAL PATH` pada include project | Repo template belum ada di komputermu, atau belum diatur di `searchRoots` / `projectMappings` (langkah 5). |
| File di WSL tapi engine lambat / tidak jalan | Pastikan Python 3 ada **di dalam WSL**. Opsional: isi `gitlabCiLocal.wslScriptPath` dengan path `ci_preview.py` di dalam WSL bila kamu punya clone repo-nya di sana. |
| Ikon visualizer tidak muncul | Pastikan file berekstensi `.yml`/`.yaml`, lalu reload window. |
| Bahasa tidak berubah | Cek setting `gitlabCiLocal.language`; tutup lalu buka lagi panel visualizer. |

Masih bermasalah? Kirim pesan error dari panel visualizer (bagian merah) ke pemilik extension. Jangan ikut menyertakan isi file CI yang sensitif (token, password, dsb.).
