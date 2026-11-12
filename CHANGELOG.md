# Changelog

## 2.2.2
- Public source repository: https://github.com/andizadry/gitlab-ci-local-visualizer (issues and feature requests welcome).
- Releases are built, tested and published from GitHub Actions with trusted publishing (no stored tokens).

## 2.2.1
- PyYAML is bundled (pure-Python 6.0.2): the only requirement is now Python 3. A system-wide PyYAML is still preferred when present.
- When Python is not found, a notification offers a download link or the install command, and opens the `gitlabCiLocal.pythonPath` setting.
- Changing `gitlabCiLocal.pythonPath` takes effect immediately.
- English README for the marketplace; Indonesian docs in `README.id.md` and `INSTALL.md`.

## 2.2.0
- Bilingual UI and engine messages (English / Bahasa Indonesia) via `gitlabCiLocal.language` (`auto`, `en`, `id`).
- Include lookup configurable from settings: `gitlabCiLocal.searchRoots`, `gitlabCiLocal.projectMappings`, or `~/.config/gitlab-ci-local/config.json`.
- Clear error message when PyYAML is not installed.
- Install guide (`INSTALL.md`).

## 2.1.1
- `include:project` resolved through group-folder layouts; faster local search.
- `CI_PROJECT_*` / `CI_SERVER_HOST` expanded in include paths (from `.git` origin).
- Consumer `CI_PROJECT_PATH` inferred for template files opened directly.

## 2.1.0
- Parent-child, multi-project and dynamic child pipelines (visualized and simulated).
- `spec:inputs` / `include:inputs`, `extends` / `default` / `!reference`, keyword validation.

## 2.0.0
- Interactive dependency graph, rules simulator with trace, diff and preset matrix, diagnostics, CodeLens, SVG/PNG/DOT export.
