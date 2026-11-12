#!/usr/bin/env bash
# Packager VSIX manual (tanpa vsce; kompatibel Node 18). Membangun staging lalu zip.
set -e
cd "$(dirname "$0")/.."
EXT_ROOT="$(pwd)"

VERSION="$(node -e 'console.log(require("./package.json").version)')"
PUBLISHER="$(node -e 'console.log(require("./package.json").publisher)')"
NAME="$(node -e 'console.log(require("./package.json").name)')"
DISPLAY="$(node -e 'console.log(require("./package.json").displayName)')"
DESC="$(node -e 'console.log(require("./package.json").description)')"
VSIX="${NAME}-${VERSION}.vsix"

STAGE="/tmp/vsix_build_${VERSION}"
rm -rf "$STAGE"
mkdir -p "$STAGE/extension"

echo "== staging files =="
# File runtime yang diperlukan ekstensi (bukan sumber webview / test / node_modules).
FILES=(extension.js package.json package.nls.json package.nls.id.json ci_preview.py rules_evaluator.py ci_inputs.py ci_keywords.py ci_i18n.py webview.html icon.png icon.svg README.md INSTALL.md CHANGELOG.md LICENSE)
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then cp "$f" "$STAGE/extension/"; else echo "  (skip missing $f)"; fi
done
# config.json lokal (berisi path pribadi) TIDAK ikut dibundel: vsix selalu membawa config kosong.
# Konfigurasi pengguna diambil dari setting gitlabCiLocal.searchRoots / projectMappings
# atau ~/.config/gitlab-ci-local/config.json.
printf '{\n  "search_roots": [],\n  "project_mappings": {}\n}\n' > "$STAGE/extension/config.json"
mkdir -p "$STAGE/extension/media" "$STAGE/extension/vendor"
cp media/*.svg "$STAGE/extension/media/" 2>/dev/null || true
cp vendor/*.js "$STAGE/extension/vendor/" 2>/dev/null || true
mkdir -p "$STAGE/extension/vendor/pyyaml/yaml"
cp vendor/pyyaml/LICENSE vendor/pyyaml/README.txt "$STAGE/extension/vendor/pyyaml/"
cp vendor/pyyaml/yaml/*.py "$STAGE/extension/vendor/pyyaml/yaml/"

# [Content_Types].xml
cat > "$STAGE/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="js" ContentType="application/javascript"/>
  <Default Extension="py" ContentType="text/plain"/>
  <Default Extension="html" ContentType="text/html"/>
  <Default Extension="xml" ContentType="text/xml"/>
  <Default Extension="md" ContentType="text/markdown"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="svg" ContentType="image/svg+xml"/>
  <Default Extension="txt" ContentType="text/plain"/>
</Types>
XML

# extension.vsixmanifest
cat > "$STAGE/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${NAME}" Version="${VERSION}" Publisher="${PUBLISHER}"/>
    <DisplayName>${DISPLAY}</DisplayName>
    <Description xml:space="preserve">${DESC}</Description>
    <Tags>gitlab,ci,yaml,visualization,offline</Tags>
    <Categories>Other,Visualization</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.70.0"/>
    </Properties>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>
XML

echo "== zip =="
cd "$STAGE"
rm -f "$EXT_ROOT/$VSIX"
zip -r -X -q "$EXT_ROOT/$VSIX" "[Content_Types].xml" extension.vsixmanifest extension
cd "$EXT_ROOT"
echo "built: $VSIX"
ls -la "$VSIX"
echo "== contents =="
unzip -l "$VSIX" | tail -30
