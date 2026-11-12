#!/usr/bin/env bash
# Sinkronkan snapshot bersih repo ini (GitLab, sumber utama) ke mirror publik di GitHub.
#
# - Mirror punya history SENDIRI: setiap sync = satu commit snapshot dari HEAD (bukan history GitLab),
#   dengan author noreply GitHub. History & email repo sumber tidak pernah ikut.
# - Yang ikut hanya file yang di-track git (git archive HEAD), dikurangi EXCLUDE.
# - Sebelum push, snapshot diaudit: path pribadi, email, dan pola dari denylist lokal
#   (~/.config/gitlab-ci-local/mirror-denylist.txt, satu regex per baris; file ini TIDAK di-commit).
#
# Pemakaian:
#   bash scripts/sync-github-mirror.sh            # sync isi terbaru ke branch main mirror
#   bash scripts/sync-github-mirror.sh --tag      # sync + buat tag v<versi package.json> -> memicu publish
#   bash scripts/sync-github-mirror.sh --dry-run  # siapkan & audit snapshot tanpa push
set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE="${GITHUB_MIRROR_REMOTE:-git@github.com:andizadry/gitlab-ci-local-visualizer.git}"
MIRROR="${GITHUB_MIRROR_DIR:-$HOME/.cache/gitlab-ci-local-visualizer-mirror}"
AUTHOR_NAME="andizadry"
AUTHOR_EMAIL="79890107+andizadry@users.noreply.github.com"
DENYLIST="${GITHUB_MIRROR_DENYLIST:-$HOME/.config/gitlab-ci-local/mirror-denylist.txt}"
EXCLUDE=(".kiro")

TAG=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --tag) TAG=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "argumen tidak dikenal: $arg" >&2; exit 2 ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree belum bersih. Commit dulu perubahan di repo sumber." >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
SRC_REV="$(git rev-parse --short HEAD)"

g() { git -C "$MIRROR" -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" "$@"; }

# 1. Siapkan clone mirror (atau repo baru bila remote masih kosong).
if [ ! -d "$MIRROR/.git" ]; then
  mkdir -p "$MIRROR"
  git -C "$MIRROR" init -q -b main
  git -C "$MIRROR" remote add origin "$REMOTE"
fi
if [ "$DRY" -eq 0 ]; then
  git -C "$MIRROR" fetch -q origin || true
fi
if git -C "$MIRROR" rev-parse --verify -q origin/main >/dev/null; then
  git -C "$MIRROR" checkout -q -B main origin/main
fi

# 2. Ganti isi working tree mirror dengan snapshot HEAD.
find "$MIRROR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$MIRROR"
for p in "${EXCLUDE[@]}"; do rm -rf "${MIRROR:?}/$p"; done

# 3. Audit snapshot.
fail=0
audit() {  # $1 = deskripsi, $2 = regex (ERE), $3 = regex pengecualian (opsional)
  local hits
  [ -n "$2" ] || return 0
  hits="$(grep -rnIE --exclude-dir=.git --exclude=package-lock.json -e "$2" "$MIRROR" || true)"
  if [ -n "${3:-}" ] && [ -n "$hits" ]; then
    hits="$(echo "$hits" | grep -vE -e "$3" || true)"
  fi
  if [ -n "$hits" ]; then
    echo "AUDIT GAGAL ($1):" >&2
    echo "$hits" | sed "s#^$MIRROR/##" | cut -c1-200 >&2
    fail=1
  fi
}
# Path home nyata (contoh dummy /home/me, /home/saya, /home/user diizinkan).
audit "path home pribadi" "/home/[a-z_][a-z0-9_.-]*/|/Users/[A-Za-z][A-Za-z0-9_.-]*/|C:\\\\Users\\\\[A-Za-z]" \
      "/home/(me|saya|user)/|/Users/(me|user)/"
SRC_EMAIL="$(git config user.email || true)"
if [ -n "$SRC_EMAIL" ]; then
  audit "email pribadi" "$(printf '%s' "$SRC_EMAIL" | sed 's/[][.*^$+?(){}|\\]/\\&/g')"
fi
audit "token / kunci" "glpat-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY"
[ -f "$MIRROR/config.json" ] && { echo "AUDIT GAGAL: config.json ikut ter-snapshot" >&2; fail=1; }
if [ -f "$DENYLIST" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] || [ "${pat#\#}" != "$pat" ] && continue
    audit "denylist" "$pat"
  done < "$DENYLIST"
else
  echo "Peringatan: denylist $DENYLIST tidak ada; hanya audit generik yang dijalankan." >&2
fi
if [ "$fail" -ne 0 ]; then
  echo "Dibatalkan: tidak ada yang di-commit/push ke mirror." >&2
  exit 1
fi

# 4. Commit snapshot.
g add -A
if g diff --cached --quiet; then
  echo "Tidak ada perubahan isi dibanding mirror."
else
  if [ "$TAG" -eq 1 ]; then MSG="Release v$VERSION"; else MSG="Sync v$VERSION"; fi
  g commit -q -m "$MSG" -m "Snapshot of upstream $SRC_REV."
  echo "Commit mirror: $(g log --oneline -1)"
fi

if [ "$DRY" -eq 1 ]; then
  echo "Dry run: snapshot siap di $MIRROR (belum di-push)."
  exit 0
fi

# 5. Push (+ tag).
g push -q origin main
echo "Pushed main -> $REMOTE"
if [ "$TAG" -eq 1 ]; then
  if g rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || g ls-remote --exit-code --tags origin "v$VERSION" >/dev/null 2>&1; then
    echo "Tag v$VERSION sudah ada. Naikkan versi di package.json dulu." >&2
    exit 1
  fi
  g tag -a "v$VERSION" -m "v$VERSION"
  g push -q origin "v$VERSION"
  echo "Pushed tag v$VERSION -> workflow publish berjalan di GitHub Actions."
fi
