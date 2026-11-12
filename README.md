# GitLab CI Local Visualizer (100% Offline)

Preview, resolve, visualize and **simulate** GitLab CI pipelines entirely on your machine: no internet connection, no push to a remote, no GitLab Runner.

- Resolves `include: local | file | project` recursively from your local clones.
- Interactive dependency graph (stages, jobs, templates, includes, `needs`, `extends`).
- Rules simulator: see which jobs **RUN / SKIP / MANUAL / DELAYED / NEVER** for a given branch, tag, MR or schedule, with a step-by-step explanation.
- Parent-child, multi-project and dynamic child pipelines.
- Diagnostics in the **Problems** panel and CodeLens on every job.
- UI in **English** and **Bahasa Indonesia**.

> Bahasa Indonesia: see `README.id.md` and `INSTALL.md` (both shipped inside the extension package).
>
> All paths, project names and variables in this document are dummy examples.

---

## Requirements

The only requirement is **Python 3**. The analysis engine and its YAML library (PyYAML) are bundled with the extension; nothing else needs to be installed, and no internet connection is used.

Python 3 must be available **where your CI files live**:

| Your `.gitlab-ci.yml` is on... | Python 3 needed on... | Usually |
|---|---|---|
| Linux / macOS | that machine | already installed |
| WSL, opened from a Windows editor (`\\wsl.localhost\...`) | **inside the WSL distro** | already installed on Ubuntu |
| Windows (e.g. `C:\repos\app`) | Windows | install from [python.org](https://www.python.org/downloads/) and enable *Add python.exe to PATH* |

If Python is not found, the extension shows a notification with a download link or the install command, and a shortcut to the `gitlabCiLocal.pythonPath` setting.

If PyYAML is already installed on your system, it is used instead of the bundled copy (it is faster thanks to its C extension).

---

## Getting started

1. Open a GitLab CI file (e.g. `.gitlab-ci.yml`).
2. Open the visualizer in one of these ways:
   - Click the visualizer icon in the editor title bar.
   - Command Palette: **GitLab CI Local: Open Visualizer**.
   - Right-click the editor tab or a YAML file in the Explorer.
3. The panel opens beside the editor with three tabs: **Dependency Graph**, **File Hierarchy**, **Merged YAML**.

The view refreshes automatically when you save a YAML file.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `gitlabCiLocal.language` | `auto` | UI and message language: `auto` (follows the editor language), `en`, `id`. |
| `gitlabCiLocal.searchRoots` | `[]` | Folders searched to resolve `include:project` locally. |
| `gitlabCiLocal.projectMappings` | `{}` | Explicit `group/project` → local folder mapping, checked before `searchRoots`. |
| `gitlabCiLocal.dynamicChildren` | `{}` | Map a dynamic child pipeline to a sample YAML file. |
| `gitlabCiLocal.pythonPath` | `""` | Python interpreter to use (auto-detected when empty). |
| `gitlabCiLocal.wslScriptPath` | `""` | Path to a `ci_preview.py` inside WSL (optional; the bundled copy is used otherwise). |

### Resolving `include:project`

`include: local` works out of the box. For `include: project`, tell the extension where your clones are:

```jsonc
// settings.json (dummy example)
{
  "gitlabCiLocal.searchRoots": ["/home/me/repos"],
  "gitlabCiLocal.projectMappings": {
    "my-group/ci-templates": "/home/me/repos/ci-templates"
  }
}
```

- A project is found at `<searchRoot>/<project-name>`, at `<searchRoot>/<group>/<subgroup>/<project>`, or in a matching group layout next to the file you opened.
- For files in WSL, use Linux paths (`/home/me/repos`), not `\\wsl.localhost\...`.
- The same configuration can live in `~/.config/gitlab-ci-local/config.json` (or the path in `GITLAB_CI_LOCAL_CONFIG`):

```json
{
  "search_roots": ["/home/me/repos"],
  "project_mappings": { "my-group/ci-templates": "/home/me/repos/ci-templates" }
}
```

Predefined variables in include paths (`$CI_PROJECT_PATH`, `$CI_PROJECT_NAME`, `$CI_PROJECT_NAMESPACE`, `$CI_SERVER_HOST`, ...) are expanded from the repository's `origin` remote. When you open a shared template file directly, the consumer project path is inferred and reported as an info diagnostic.

---

## Views

**Standard** (default): one column per stage with job cards (name, `extends`, tags, `manual`, source file). Click a card for details. During a simulation the cards show status badges.

**Detail**: interactive dependency graph.

- Left-click a node to highlight it and its neighbours. Right-click for **Open file**, **Focus & highlight**, **Copy path**.
- Drag nodes, zoom to cursor, pan, fit to screen, minimap, LR/TB layout.
- Filter edges by type: `includes`, `defines_template`, `defines_job`, `extends`, `needs`, `stage_contains`, `triggers`.
- Smart search: free text, or `tag:`, `stage:`, `status:` (e.g. `status:run`).
- Export as **SVG**, **PNG** or **Graphviz DOT**.

The job drawer shows variables, rules, scripts, `extends`/`needs` links (click to jump to the source line) and a **Copy Resolved Job** button (job with `extends`, `default` and `!reference` merged).

The view mode, layout direction, dragged node positions, filters, scenario and search are remembered between sessions.

---

## Rules simulator

The **Rules Simulation** panel sits above the graph.

1. Fill in CI variables: named fields (`CI_COMMIT_BRANCH`, `CI_COMMIT_TAG`, `CI_COMMIT_REF_NAME`, `CI_DEFAULT_BRANCH`, `CI_MERGE_REQUEST_*`), a `CI_PIPELINE_SOURCE` dropdown, plus free key-value pairs.
2. Optionally list **changed** and **existing** files (for `rules:changes` and `rules:exists`; there is no git diff offline).
3. Or pick a preset: `push to main`, `merge request`, `tag pipeline`, `scheduled`.
4. Enable **Simulation Mode** or click **Evaluate**.

Each job gets a status and a reason (which rule matched and its expression) plus the effective `when`.

- **Rules Trace**: in the job drawer, every `rule[i]` with the result of each `if` / `changes` / `exists` clause, the effective rule, and rules that were never reached.
- **Snapshot / Diff**: save the current result, change the scenario, and highlight jobs whose status changed.
- **Preset Matrix**: run all presets at once and show a `job × preset` table.

Supported semantics:

- Operators `==`, `!=`, `=~`, `!~`, `&&`, `||`, parentheses; regex literals with flags; `null`; empty strings; bare `$VAR` truthiness. Expressions are parsed by a dedicated parser (no `eval`).
- First-match `rules`; `when`: `on_success`, `on_failure`, `always`, `manual`, `delayed`, `never`; job-level `when`.
- `workflow:rules` (including `workflow:rules:variables`); a blocked pipeline marks every job `NEVER`.
- Legacy `only` / `except` (refs, variables, changes).
- `include:rules`: jobs from a file that is not included become `NEVER`.
- `extends` (deep merge), `default:` with `inherit:default`, `!reference`.
- Variable precedence: scenario input > job `variables` > global `variables`.

Regular expressions are evaluated with Python's `re` module, which is close to but not identical to GitLab's RE2.

---

## Downstream pipelines

Jobs with `trigger:` (bridge jobs) show their downstream pipeline:

- **Standard** view: a `⤷ child` badge on the bridge card and a **Downstream pipelines** panel with the child's stages (nested for grandchildren).
- **Detail** view: `child pipeline` / `dynamic child` nodes, `triggers` edges from the bridge job, and the child's jobs with their `needs`.

The simulation follows GitLab's rules:

- A bridge that is `NEVER` or `SKIP` does not trigger its child. A `MANUAL` or `DELAYED` bridge triggers it after the job runs.
- Global and bridge variables are forwarded by default (`forward:yaml_variables`); `inherit:variables` is respected. Scenario (pipeline) variables are forwarded only with `forward:pipeline_variables: true`.
- Same-project children get `CI_PIPELINE_SOURCE=parent_pipeline`. Multi-project downstreams get `CI_PIPELINE_SOURCE=pipeline` and the `trigger:branch`.
- `workflow:rules` inside the child is evaluated.
- Depth is limited to two child levels as in GitLab. Cycles are detected.
- `strategy: mirror | depend` is shown on the bridge.

Multi-project downstreams (`trigger:project`) are located through `projectMappings` / `searchRoots`.

**Dynamic children** (`trigger:include:artifact`) only exist at runtime, so the engine looks for a sample file, in this order:

1. `gitlabCiLocal.dynamicChildren`. The key can be the bridge job, the artifact file name, or the generator job.
2. `dynamic_children` in a config file.
3. Auto-detect: `<ci folder>/<artifact>`, `<ci folder>/.ci-samples/<artifact name>`, or `.ci-samples/<bridge job>.yml` up to the repository root.

Without a sample, the child is shown as a placeholder with a hint. Use **📂 Choose sample file…** in the panel to pick one; it is saved to the workspace settings.

```jsonc
{
  "gitlabCiLocal.dynamicChildren": {
    "trigger-generated": "samples/generated-pipeline.yml"
  }
}
```

---

## CI/CD inputs

`spec:inputs` headers, `include:inputs` and `trigger:include:inputs` are supported, including `$[[ inputs.name | function ]]` interpolation (`expand_vars`, `truncate`, `posix_escape`, `split`, `default`). Inputs are validated against their type, `options` and `regex`.

---

## Diagnostics and CodeLens

While the visualizer is open (and on every save), problems appear in the **Problems** panel and link to the exact source line:

- `needs` pointing to a missing job, a later stage, or forming a cycle.
- Missing `extends` targets; unknown stages.
- Unknown keywords (with spelling suggestions), `rules` combined with `only/except`, keywords not allowed on trigger jobs, deprecated global keywords.
- Invalid inputs.
- Includes that cannot be resolved. `component`, `remote` and `template` includes are reported as information, since they cannot be fetched offline.

**CodeLens** adds a line above every job with its stage, number of `needs`, and an action to open the visualizer focused on that job.

---

## WSL and Windows

When a file lives in WSL (`\\wsl.localhost\<distro>\...`) and the editor runs on Windows, the extension runs the engine inside that distro through `wsl.exe` and converts paths both ways, so **Open file** always opens the right file. It also runs natively on Linux and macOS.

---

## Command line

The engine can be used without the editor:

```bash
python3 ci_preview.py path/to/.gitlab-ci.yml               # summary
python3 ci_preview.py path/to/.gitlab-ci.yml --files       # resolved includes
python3 ci_preview.py path/to/.gitlab-ci.yml --job build   # one job
python3 ci_preview.py path/to/.gitlab-ci.yml -o merged.yml # merged YAML
python3 ci_preview.py path/to/.gitlab-ci.yml --json        # full analysis (JSON)

# simulate rules
python3 ci_preview.py path/to/.gitlab-ci.yml --simulate \
  --var CI_COMMIT_BRANCH=main --var CI_PIPELINE_SOURCE=push --changed-file src/app.py

# options
#   --lang en|id                 message language (default: en, or $GITLAB_CI_LOCAL_LANG)
#   --config-json '<json>'       extra search_roots / project_mappings
#   --dynamic-child KEY=PATH     sample file for a dynamic child (repeatable)
```

---

## Privacy

Everything runs locally. The extension makes no network requests, the webview only loads bundled resources under a strict Content Security Policy, and nothing is collected or sent anywhere.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not find a Python 3 interpreter` | Install Python 3 where your files live, or set `gitlabCiLocal.pythonPath`. |
| Include shows `COULD NOT RESOLVE LOCAL PATH` | Clone the included project locally and add it to `searchRoots` / `projectMappings`. |
| No visualizer icon | Make sure the file ends in `.yml` / `.yaml`, then reload the window. |

---

## Feedback

Bug reports and feature requests: https://github.com/andizadry/gitlab-ci-local-visualizer/issues

---

## License

MIT. Bundled third-party code: [dagre](https://github.com/dagrejs/dagre) 0.8.5 (MIT) and [PyYAML](https://github.com/yaml/pyyaml) 6.0.2 pure-Python (MIT, license in `vendor/pyyaml/LICENSE`).
