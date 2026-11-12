const vscode = require('vscode');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let currentPanel = undefined;
let currentFilePath = undefined;
let diagnosticCollection = undefined;

// ------- i18n (host side) -------
// Setting `gitlabCiLocal.language`: 'auto' (ikut bahasa editor) | 'en' | 'id'.
function resolveLang() {
    const setting = String(vscode.workspace.getConfiguration('gitlabCiLocal').get('language') || 'auto').toLowerCase();
    if (setting === 'en' || setting === 'id') return setting;
    const ui = String((vscode.env && vscode.env.language) || 'en').toLowerCase();
    return ui.startsWith('id') ? 'id' : 'en';
}

const HOST_MESSAGES = {
    en: {
        openLabel: 'Use as child sample',
        pickTitle: 'Choose a sample YAML file for dynamic child pipeline "{0}"',
        lensOpen: 'open visualizer',
        noFile: 'Please open a GitLab CI YAML file first.',
        fileNotFound: 'File not found: {0}',
        copied: 'Copied resolved job to clipboard.',
        copyFailed: 'Copy failed: {0}',
        loading: 'Parsing pipeline for',
        errorTitle: 'Failed to Preview CI Pipeline',
        retry: 'Retry',
        noPythonWsl: 'GitLab CI Local Visualizer needs Python 3 inside WSL "{0}". Install it in a WSL terminal: sudo apt update && sudo apt install -y python3',
        noPythonWin: 'GitLab CI Local Visualizer needs Python 3. Install it from python.org (enable "Add python.exe to PATH"), then reload the window.',
        noPythonMac: 'GitLab CI Local Visualizer needs Python 3. Install it from python.org or with "brew install python", then reload the window.',
        noPythonLinux: 'GitLab CI Local Visualizer needs Python 3. Install it with your package manager (Debian/Ubuntu: sudo apt install -y python3), then reload the window.',
        downloadPython: 'Download Python',
        copyCommand: 'Copy install command',
        commandCopied: 'Install command copied. Paste it into a terminal, then reload the window.',
        setPythonPath: 'Set Python path',
    },
    id: {
        openLabel: 'Pakai sebagai contoh child',
        pickTitle: 'Pilih file YAML contoh untuk child pipeline dinamis "{0}"',
        lensOpen: 'buka visualizer',
        noFile: 'Buka file YAML GitLab CI terlebih dahulu.',
        fileNotFound: 'File tidak ditemukan: {0}',
        copied: 'Job resolved disalin ke clipboard.',
        copyFailed: 'Gagal menyalin: {0}',
        loading: 'Mem-parsing pipeline untuk',
        errorTitle: 'Gagal Menampilkan Pipeline CI',
        retry: 'Coba lagi',
        noPythonWsl: 'GitLab CI Local Visualizer butuh Python 3 di dalam WSL "{0}". Pasang lewat terminal WSL: sudo apt update && sudo apt install -y python3',
        noPythonWin: 'GitLab CI Local Visualizer butuh Python 3. Pasang dari python.org (centang "Add python.exe to PATH"), lalu reload window.',
        noPythonMac: 'GitLab CI Local Visualizer butuh Python 3. Pasang dari python.org atau "brew install python", lalu reload window.',
        noPythonLinux: 'GitLab CI Local Visualizer butuh Python 3. Pasang lewat package manager (Debian/Ubuntu: sudo apt install -y python3), lalu reload window.',
        downloadPython: 'Unduh Python',
        copyCommand: 'Salin perintah install',
        commandCopied: 'Perintah install disalin. Tempel di terminal, lalu reload window.',
        setPythonPath: 'Atur path Python',
    },
};

function hm(key, ...params) {
    const table = HOST_MESSAGES[resolveLang()] || HOST_MESSAGES.en;
    const text = table[key] !== undefined ? table[key] : (HOST_MESSAGES.en[key] || key);
    return text.replace(/\{(\d+)\}/g, (m, i) => (params[i] === undefined ? m : String(params[i])));
}

/**
 * Argumen umum engine: bahasa pesan + konfigurasi include dari setting
 * (`gitlabCiLocal.searchRoots`, `gitlabCiLocal.projectMappings`).
 * Bentuk `--x=<nilai>` dipakai agar buildInvocation tidak ikut menerjemahkan nilainya;
 * path absolut dikonversi sendiri ke bentuk environment target.
 */
function engineArgs(env) {
    const cfg = vscode.workspace.getConfiguration('gitlabCiLocal');
    const args = ['--lang=' + resolveLang()];
    const roots = (cfg.get('searchRoots') || [])
        .filter((r) => typeof r === 'string' && r.trim())
        .map((r) => toEnvPath(r.trim(), env));
    const rawMaps = cfg.get('projectMappings') || {};
    const maps = {};
    if (rawMaps && typeof rawMaps === 'object') {
        for (const [k, v] of Object.entries(rawMaps)) {
            if (typeof v === 'string' && v.trim() && k.trim()) maps[k.trim()] = toEnvPath(v.trim(), env);
        }
    }
    if (roots.length || Object.keys(maps).length) {
        // Base64: `wsl.exe -- ...` melewati shell default distro (bash/zsh) yang bisa merusak
        // kutip / kurung kurawal / koma pada JSON mentah.
        const json = JSON.stringify({ search_roots: roots, project_mappings: maps });
        args.push('--config-json=b64:' + Buffer.from(json, 'utf-8').toString('base64'));
    }
    return args;
}

// Cache of the resolved python interpreter per environment so we don't probe every refresh.
// key: 'native' | `wsl:<distro>` -> string command (e.g. 'python3')
const pythonCmdCache = {};

function getScriptPath() {
    const candidates = [
        path.join(__dirname, 'ci_preview.py'),
        path.join(__dirname, '..', 'ci_preview.py')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return candidates[0];
}

/**
 * Detect where a given file physically lives and how we should reach it.
 *
 * Returns an object describing the execution environment:
 *   { kind: 'native' }                          -> run python directly, use paths as-is
 *   { kind: 'wsl', distro: 'Ubuntu-24.04' }     -> run via `wsl -d <distro> -- ...`, convert paths to Linux
 *
 * This lets a single Windows-side Kiro/VS Code install transparently drive the
 * Python engine that lives inside WSL, while still working natively on Linux/macOS.
 */
function detectEnv(fsPath) {
    // On Linux/macOS the extension host is already in the target environment.
    if (process.platform !== 'win32') {
        return { kind: 'native' };
    }

    // On Windows, files opened from WSL appear under a UNC path:
    //   \\wsl.localhost\<distro>\home\...   (newer)
    //   \\wsl$\<distro>\home\...            (older)
    const wsl = parseWslUncPath(fsPath);
    if (wsl) {
        return { kind: 'wsl', distro: wsl.distro };
    }

    // A plain Windows path -> run python natively on Windows.
    return { kind: 'native' };
}

/**
 * Parse a Windows UNC path that points into a WSL distro.
 * Returns { distro, linuxPath } or null if it isn't a WSL UNC path.
 */
function parseWslUncPath(fsPath) {
    if (!fsPath) return null;
    // Normalize forward slashes that VS Code sometimes hands back.
    const p = fsPath.replace(/\//g, '\\');
    const m = p.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i);
    if (!m) return null;
    const distro = m[1];
    const rest = m[2].replace(/\\/g, '/');
    return { distro, linuxPath: '/' + rest.replace(/^\/+/, '') };
}

/**
 * Convert any path into the form the Python engine expects for a given env.
 * - native: return the path untouched
 * - wsl:    convert Windows drive paths / WSL UNC paths into Linux paths
 */
function toEnvPath(fsPath, env) {
    if (env.kind !== 'wsl') return fsPath;

    const wsl = parseWslUncPath(fsPath);
    if (wsl) return wsl.linuxPath;

    // Windows drive path (C:\foo\bar) accessed from inside WSL -> /mnt/c/foo/bar
    const drive = fsPath.match(/^([A-Za-z]):[\\/](.*)$/);
    if (drive) {
        return '/mnt/' + drive[1].toLowerCase() + '/' + drive[2].replace(/\\/g, '/');
    }

    // Already a Linux-style path.
    return fsPath.replace(/\\/g, '/');
}

/**
 * Inverse of toEnvPath: convert a path the engine reports (often a Linux path
 * coming from a WSL run) back into a path the Windows extension host can open.
 * - Non-Windows hosts and already-Windows/UNC paths are returned unchanged.
 * - /mnt/<drive>/... maps back to <DRIVE>:\...
 * - Other absolute Linux paths map to the WSL UNC form for the relevant distro.
 */
function toHostPath(enginePath, env) {
    if (!enginePath) return enginePath;
    if (process.platform !== 'win32') return enginePath;
    // Already a Windows drive path or UNC path -> leave as-is.
    if (/^[A-Za-z]:[\\/]/.test(enginePath) || /^\\\\/.test(enginePath)) return enginePath;
    if (!enginePath.startsWith('/')) return enginePath;

    // /mnt/c/foo/bar -> C:\foo\bar
    const mnt = enginePath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (mnt) return mnt[1].toUpperCase() + ':\\' + mnt[2].replace(/\//g, '\\');

    // Absolute Linux path -> \\wsl.localhost\<distro>\...
    const distro = env && env.kind === 'wsl'
        ? env.distro
        : (currentFilePath ? (parseWslUncPath(currentFilePath) || {}).distro : null);
    if (!distro) return enginePath;
    return '\\\\wsl.localhost\\' + distro + '\\' + enginePath.replace(/^\/+/, '').replace(/\//g, '\\');
}

/**
 * Decide whether an argument looks like a filesystem path (so it should be
 * translated into the target env) versus a flag/value that must be left as-is.
 */
function looksLikePath(arg) {
    if (typeof arg !== 'string' || arg.length === 0) return false;
    if (arg.startsWith('-')) return false;
    if (/^\\\\wsl(?:\.localhost|\$)\\/i.test(arg)) return true;
    if (/^[A-Za-z]:[\\/]/.test(arg)) return true;
    if (arg.startsWith('/')) return true;
    if (/[\\/]/.test(arg)) return true;
    return false;
}

/**
 * Build the [command, args] pair for running a python script in the target env.
 * Every path-like argument (the script and the target file) is translated into
 * the target environment's path form; flags and plain values are passed through.
 */
function buildInvocation(pythonCmd, env, scriptPath, args) {
    const script = toEnvPath(scriptPath, env);
    const scriptArgs = args.map((a) => (looksLikePath(a) ? toEnvPath(a, env) : a));
    if (env.kind === 'wsl') {
        return {
            cmd: 'wsl.exe',
            argv: ['-d', env.distro, '--', pythonCmd, script, ...scriptArgs]
        };
    }
    return { cmd: pythonCmd, argv: [script, ...scriptArgs] };
}

/**
 * Argumen CLI untuk memetakan child pipeline dinamis (artifact) ke file YAML contoh,
 * dibaca dari setting `gitlabCiLocal.dynamicChildren` ({ "<bridge job | artifact | job generator>": "<path>" }).
 * Bentuk `--dynamic-child=KUNCI=PATH` dipakai agar buildInvocation tidak ikut menerjemahkan
 * argumen (diawali '-'); path absolut dikonversi sendiri ke bentuk environment target.
 * Path relatif dibiarkan: engine menyelesaikannya terhadap folder file CI yang memuat bridge job.
 */
function dynamicChildArgs(env) {
    const mapping = vscode.workspace.getConfiguration('gitlabCiLocal').get('dynamicChildren');
    if (!mapping || typeof mapping !== 'object') return [];
    const out = [];
    for (const [key, value] of Object.entries(mapping)) {
        if (typeof value !== 'string' || !value.trim() || !key.trim()) continue;
        const isAbsolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || value.startsWith('/');
        out.push('--dynamic-child=' + key + '=' + (isAbsolute ? toEnvPath(value, env) : value));
    }
    return out;
}

/** Simpan/hapus satu pemetaan sample child dinamis di setting (workspace bila ada, else global). */
async function setDynamicSample(key, value) {
    const cfg = vscode.workspace.getConfiguration('gitlabCiLocal');
    const current = Object.assign({}, cfg.get('dynamicChildren') || {});
    if (value === undefined) {
        delete current[key];
    } else {
        current[key] = value;
    }
    const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
    await cfg.update('dynamicChildren', current,
        hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
}

/** Dialog pemilihan file YAML contoh untuk child dinamis dari bridge job `key`. */
async function pickDynamicSample(key) {
    if (!key || !currentFilePath) return;
    const baseDir = path.dirname(currentFilePath);
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: vscode.Uri.file(baseDir),
        filters: { YAML: ['yml', 'yaml'] },
        openLabel: hm('openLabel'),
        title: hm('pickTitle', key)
    });
    if (!picked || !picked.length) return;
    const target = picked[0].fsPath;
    // Simpan relatif bila berada di bawah folder file CI (lebih portabel antar mesin).
    const rel = path.relative(baseDir, target);
    const value = (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel.replace(/\\/g, '/') : target;
    await setDynamicSample(key, value);
    await refreshWebview();
}

// Cache of resolved script path per env so we probe the filesystem only once.
const scriptPathCache = {};

/**
 * Choose which ci_preview.py to execute for the given environment.
 * For WSL targets, prefer a script that physically lives inside the distro so its
 * sibling config.json resolves include search_roots correctly and runs fast.
 * The canonical location can be overridden with the setting
 * `gitlabCiLocal.wslScriptPath`. Falls back to the bundled (Windows-copied) script.
 */
async function resolveScriptForEnv(env, bundledScript, pythonCmd) {
    if (env.kind !== 'wsl') return bundledScript;

    const cacheKey = `wsl:${env.distro}`;
    if (scriptPathCache[cacheKey]) return scriptPathCache[cacheKey];

    const configured = vscode.workspace
        .getConfiguration('gitlabCiLocal')
        .get('wslScriptPath');

    // Kandidat lokasi ci_preview.py di dalam distro WSL. Utamakan setting
    // `gitlabCiLocal.wslScriptPath`; contoh path di bawah hanyalah placeholder umum.
    // Bila tak ada yang cocok, fallback ke skrip bundled (buildInvocation memetakan ke /mnt/<drive>).
    const candidates = [
        configured,
        '/opt/gitlab-ci-local/vscode-extension/ci_preview.py',
        '/opt/gitlab-ci-local/ci_preview.py'
    ].filter(Boolean);

    for (const linuxPath of candidates) {
        try {
            // `test -f` inside the distro; exit 0 means it exists.
            await execFileAsync('wsl.exe', ['-d', env.distro, '--', 'test', '-f', linuxPath], { timeout: 8000 });
            scriptPathCache[cacheKey] = linuxPath;
            return linuxPath;
        } catch (e) {
            // not present, try next
        }
    }

    // Fall back to the bundled script (buildInvocation will map it to /mnt/<drive>).
    return bundledScript;
}

function execFileAsync(cmd, argv, options) {
    return new Promise((resolve, reject) => {
        execFile(cmd, argv, options, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                error.stdout = stdout;
                return reject(error);
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Find a working python interpreter for the target env, trying python3 then python.
 * Result is cached per environment.
 */
async function resolvePython(env) {
    const cacheKey = env.kind === 'wsl' ? `wsl:${env.distro}` : 'native';
    if (pythonCmdCache[cacheKey]) return pythonCmdCache[cacheKey];

    const override = vscode.workspace
        .getConfiguration('gitlabCiLocal')
        .get('pythonPath');

    const candidates = override
        ? [override]
        : (process.platform === 'win32' && env.kind === 'native'
            ? ['python', 'python3', 'py']
            : ['python3', 'python']);

    for (const candidate of candidates) {
        try {
            const inv = env.kind === 'wsl'
                ? { cmd: 'wsl.exe', argv: ['-d', env.distro, '--', candidate, '--version'] }
                : { cmd: candidate, argv: ['--version'] };
            await execFileAsync(inv.cmd, inv.argv, { timeout: 8000 });
            pythonCmdCache[cacheKey] = candidate;
            return candidate;
        } catch (e) {
            // try next candidate
        }
    }
    const where = env.kind === 'wsl' ? `WSL distro "${env.distro}"` : 'this system';
    notifyPythonMissing(env);
    throw new Error(
        `Could not find a Python 3 interpreter on ${where}. ` +
        `Tried: ${candidates.join(', ')}. Please install Python 3 and ensure it is on PATH.`
    );
}

// Notifikasi Python tidak ditemukan: sekali per sesi per environment (CodeLens & refresh bisa memicu berulang).
const pythonMissingNotified = new Set();

function notifyPythonMissing(env) {
    const key = env.kind === 'wsl' ? 'wsl:' + env.distro : 'native';
    if (pythonMissingNotified.has(key)) return;
    pythonMissingNotified.add(key);

    let message;
    const actions = [];
    if (env.kind === 'wsl') {
        message = hm('noPythonWsl', env.distro);
        actions.push(hm('copyCommand'));
    } else if (process.platform === 'win32') {
        message = hm('noPythonWin');
        actions.push(hm('downloadPython'));
    } else if (process.platform === 'darwin') {
        message = hm('noPythonMac');
        actions.push(hm('downloadPython'));
    } else {
        message = hm('noPythonLinux');
        actions.push(hm('copyCommand'));
    }
    actions.push(hm('setPythonPath'));

    vscode.window.showErrorMessage(message, ...actions).then(async (choice) => {
        if (!choice) return;
        if (choice === hm('downloadPython')) {
            await vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
        } else if (choice === hm('copyCommand')) {
            await vscode.env.clipboard.writeText('sudo apt update && sudo apt install -y python3');
            vscode.window.showInformationMessage(hm('commandCopied'));
        } else if (choice === hm('setPythonPath')) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'gitlabCiLocal.pythonPath');
        }
    }, () => {});
}

// Setelah setting pythonPath diubah: buang cache & izinkan notifikasi lagi.
function resetPythonCache() {
    for (const k of Object.keys(pythonCmdCache)) delete pythonCmdCache[k];
    pythonMissingNotified.clear();
}

function runCiPreview(filePath) {
    return new Promise(async (resolve, reject) => {
        const script = getScriptPath();
        if (!fs.existsSync(script)) {
            return reject('ci_preview.py script not found at: ' + script);
        }
        const env = detectEnv(filePath);
        let pythonCmd;
        try {
            pythonCmd = await resolvePython(env);
        } catch (e) {
            return reject(e.message || String(e));
        }

        // When targeting WSL, prefer a script that already lives inside the distro
        // (its sibling config.json carries valid Linux search_roots). This avoids
        // running the Windows-copied script over the slower /mnt/c bridge and keeps
        // include resolution correct. Falls back to the bundled script otherwise.
        const scriptForEnv = await resolveScriptForEnv(env, script, pythonCmd);
        const { cmd, argv } = buildInvocation(pythonCmd, env, scriptForEnv, [filePath, '--json', ...engineArgs(env), ...dynamicChildArgs(env)]);

        execFile(cmd, argv, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                const envDesc = env.kind === 'wsl' ? ` (via WSL: ${env.distro})` : '';
                return reject(
                    `Failed to run pipeline parser${envDesc}.\n` +
                    (stderr ? stderr + '\n' : '') +
                    (error.message || '')
                );
            }
            try {
                const data = JSON.parse(stdout);
                resolve(data);
            } catch (e) {
                reject('Failed to parse CI data: ' + e.message + '\nOutput was: ' + stdout.slice(0, 300));
            }
        });
    });
}

/**
 * Run the pipeline rules simulator for a given file + scenario.
 *
 * Mirrors runCiPreview's environment resolution (detectEnv -> resolvePython ->
 * resolveScriptForEnv -> buildInvocation) but invokes the engine with
 * `--simulate --scenario-json -` and streams the scenario object to the child
 * process's STDIN as JSON. Uses spawn (instead of execFile) so we can write to
 * stdin; stdout/stderr chunks are collected in arrays so there is no maxBuffer
 * limit. Resolves to the parsed result object { pipeline_created, workflow, results }.
 *
 * The scenario is sent exactly as given (JSON.stringify) without altering any
 * key or value.
 */
function runCiSimulate(filePath, scenario) {
    return new Promise(async (resolve, reject) => {
        const script = getScriptPath();
        if (!fs.existsSync(script)) {
            return reject('ci_preview.py script not found at: ' + script);
        }
        const env = detectEnv(filePath);
        let pythonCmd;
        try {
            pythonCmd = await resolvePython(env);
        } catch (e) {
            return reject(e.message || String(e));
        }

        const scriptForEnv = await resolveScriptForEnv(env, script, pythonCmd);
        const { cmd, argv } = buildInvocation(pythonCmd, env, scriptForEnv, [filePath, '--simulate', '--scenario-json', '-', ...engineArgs(env), ...dynamicChildArgs(env)]);

        let child;
        try {
            child = spawn(cmd, argv, {});
        } catch (e) {
            return reject(e.message || String(e));
        }

        const stdoutChunks = [];
        const stderrChunks = [];
        let settled = false;

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            const envDesc = env.kind === 'wsl' ? ` (via WSL: ${env.distro})` : '';
            reject(`Failed to run pipeline simulator${envDesc}.\n` + (err.message || String(err)));
        });

        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');
            if (code !== 0) {
                const envDesc = env.kind === 'wsl' ? ` (via WSL: ${env.distro})` : '';
                return reject(
                    `Failed to run pipeline simulator${envDesc}.\n` +
                    (stderr ? stderr + '\n' : '') +
                    `Process exited with code ${code}.`
                );
            }
            try {
                const data = JSON.parse(stdout);
                resolve(data);
            } catch (e) {
                reject('Failed to parse simulation data: ' + e.message + '\nOutput was: ' + stdout.slice(0, 300));
            }
        });

        // Stream the scenario to the engine via stdin, exactly as provided.
        try {
            child.stdin.write(JSON.stringify(scenario));
            child.stdin.end();
        } catch (e) {
            if (!settled) {
                settled = true;
                reject(e.message || String(e));
            }
        }
    });
}

// ------- CodeLens: info + aksi per job di file YAML -------
const codeLensCache = new Map(); // key: uri.toString()+version -> CodeLens[]

function looksLikeCiFile(document) {
    const n = (document.fileName || '').toLowerCase();
    if (n.endsWith('.gitlab-ci.yml') || n.endsWith('.gitlab-ci.yaml')) return true;
    const head = document.getText().slice(0, 4000);
    return /\n(stages|include|workflow|variables)\s*:/.test('\n' + head) || /^[\w.-]+:\s*\n\s+(stage|script|image|extends|rules)\s*:/m.test(head);
}

const ciCodeLensProvider = {
    async provideCodeLenses(document, token) {
        try {
            if (!looksLikeCiFile(document)) return [];
            const key = document.uri.toString() + '@' + document.version + '#' + resolveLang();
            if (codeLensCache.has(key)) return codeLensCache.get(key);
            const ciData = await runCiPreview(document.uri.fsPath);
            if (token && token.isCancellationRequested) return [];
            const env = detectEnv(document.uri.fsPath);
            const thisHost = document.uri.fsPath;
            const lenses = [];
            const jobs = (ciData && ciData.jobs) || {};
            for (const name of Object.keys(jobs)) {
                const job = jobs[name] || {};
                const jobHost = toHostPath(job.source_file, env);
                if (!jobHost || jobHost.toLowerCase() !== thisHost.toLowerCase()) continue;
                const line = Math.max(0, (parseInt(job.line_number, 10) || 1) - 1);
                const range = new vscode.Range(line, 0, line, 1);
                const needsN = Array.isArray(job.needs) ? job.needs.length : 0;
                const title = '\u25B6 GitLab CI: stage ' + (job.stage || 'test') + (needsN ? (' \u00B7 needs ' + needsN) : '') + ' \u00B7 ' + hm('lensOpen');
                lenses.push(new vscode.CodeLens(range, {
                    title: title,
                    command: 'gitlab-ci-local.openVisualizerAtJob',
                    arguments: [document.uri, name],
                }));
            }
            codeLensCache.set(key, lenses);
            // batasi ukuran cache
            if (codeLensCache.size > 20) { const k = codeLensCache.keys().next().value; codeLensCache.delete(k); }
            return lenses;
        } catch (e) {
            return [];
        }
    }
};

function activate(context) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('gitlab-ci-local');
    context.subscriptions.push(diagnosticCollection);

    // CodeLens untuk file YAML.
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider({ language: 'yaml' }, ciCodeLensProvider)
    );
    // Command dari CodeLens: buka visualizer & fokus job.
    context.subscriptions.push(
        vscode.commands.registerCommand('gitlab-ci-local.openVisualizerAtJob', async (uri, jobName) => {
            if (uri && uri.fsPath) currentFilePath = uri.fsPath;
            await vscode.commands.executeCommand('gitlab-ci-local.openVisualizer', uri);
            if (currentPanel && jobName) {
                try { currentPanel.webview.postMessage({ command: 'focusJob', job: jobName }); } catch (e) {}
            }
        })
    );
    // Bersihkan cache CodeLens saat dokumen berubah.
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (e) {
        if (e && e.document) { const base = e.document.uri.toString(); for (const k of Array.from(codeLensCache.keys())) { if (k.indexOf(base + '@') === 0) codeLensCache.delete(k); } }
    }));

    const disposable = vscode.commands.registerCommand('gitlab-ci-local.openVisualizer', async (uri) => {
        let targetFile = uri ? uri.fsPath : null;

        if (!targetFile && vscode.window.activeTextEditor) {
            targetFile = vscode.window.activeTextEditor.document.uri.fsPath;
        }

        if (!targetFile) {
            vscode.window.showErrorMessage(hm('noFile'));
            return;
        }

        currentFilePath = targetFile;
        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;

        if (currentPanel) {
            currentPanel.reveal(column);
        } else {
            currentPanel = vscode.window.createWebviewPanel(
                'gitlabCiVisualizer',
                'GitLab CI Preview: ' + path.basename(targetFile),
                column,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.file(__dirname)]
                }
            );

            currentPanel.onDidDispose(() => {
                currentPanel = undefined;
            }, null, context.subscriptions);

            currentPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'openFile') {
                    const env = detectEnv(currentFilePath);
                    const hostPath = toHostPath(message.path, env);
                    if (hostPath && fs.existsSync(hostPath)) {
                        const doc = await vscode.workspace.openTextDocument(hostPath);
                        const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
                        if (message.line && !isNaN(parseInt(message.line, 10))) {
                            const targetLine = Math.max(0, parseInt(message.line, 10) - 1);
                            const pos = new vscode.Position(targetLine, 0);
                            editor.selection = new vscode.Selection(pos, pos);
                            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                        }
                    } else {
                        vscode.window.showWarningMessage(hm('fileNotFound', hostPath || message.path || 'unknown'));
                    }
                } else if (message.command === 'refresh') {
                    await refreshWebview();
                } else if (message.command === 'simulate') {
                    try {
                        const sim = await runCiSimulate(currentFilePath, message.scenario || {});
                        currentPanel.webview.postMessage({ command: 'simulationResult', ...sim });
                    } catch (err) {
                        currentPanel.webview.postMessage({ command: 'simulationResult', error: String(err && err.message ? err.message : err) });
                    }
                } else if (message.command === 'simulateMatrix') {
                    // v2.0.0 #3 — jalankan beberapa skenario (matrix) sekuensial lalu kirim balik.
                    const scenarios = Array.isArray(message.scenarios) ? message.scenarios : [];
                    const columns = [];
                    for (const entry of scenarios) {
                        const label = (entry && entry.label) ? String(entry.label) : 'scenario';
                        const scenario = (entry && entry.scenario) ? entry.scenario : {};
                        try {
                            const sim = await runCiSimulate(currentFilePath, scenario);
                            columns.push({ label, ...sim });
                        } catch (err) {
                            columns.push({ label, error: String(err && err.message ? err.message : err) });
                        }
                    }
                    currentPanel.webview.postMessage({ command: 'simulationMatrixResult', columns });
                } else if (message.command === 'pickDynamicSample') {
                    // Pilih file YAML contoh untuk child pipeline dinamis (hasil generate saat runtime).
                    await pickDynamicSample(String(message.job || ''));
                } else if (message.command === 'clearDynamicSample') {
                    await setDynamicSample(String(message.job || ''), undefined);
                    await refreshWebview();
                } else if (message.command === 'copyText') {
                    // v2.0.0 #7b — fallback copy ke clipboard via host bila navigator.clipboard tak ada.
                    try {
                        await vscode.env.clipboard.writeText(String(message.text || ''));
                        vscode.window.showInformationMessage(hm('copied'));
                    } catch (err) {
                        vscode.window.showWarningMessage(hm('copyFailed', String(err && err.message ? err.message : err)));
                    }
                }
            });
        }

        await refreshWebview();
    });

    context.subscriptions.push(disposable);

    // Ganti bahasa / konfigurasi include → render ulang.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('gitlabCiLocal.pythonPath')) resetPythonCache();
        if (['language', 'searchRoots', 'projectMappings', 'pythonPath'].some((k) => e.affectsConfiguration('gitlabCiLocal.' + k))) {
            codeLensCache.clear();
            await refreshWebview();
        }
    }));

    vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (currentPanel && currentFilePath && (doc.uri.fsPath === currentFilePath || doc.uri.fsPath.endsWith('.yml') || doc.uri.fsPath.endsWith('.yaml'))) {
            await refreshWebview();
        }
    });
}
function publishDiagnostics(ciData) {
    if (!diagnosticCollection) return;
    diagnosticCollection.clear();
    const diags = (ciData && Array.isArray(ciData.diagnostics)) ? ciData.diagnostics : [];
    if (!diags.length) return;
    const env = detectEnv(currentFilePath);
    const byFile = new Map();
    for (const d of diags) {
        const hostPath = toHostPath(d.source_file || currentFilePath, env) || currentFilePath;
        const line = Math.max(0, (parseInt(d.line_number, 10) || 1) - 1);
        const sev = d.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : (d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
        const range = new vscode.Range(line, 0, line, 200);
        const diag = new vscode.Diagnostic(range, d.message || 'CI issue', sev);
        diag.source = 'gitlab-ci-local';
        if (d.code) diag.code = d.code;
        if (!byFile.has(hostPath)) byFile.set(hostPath, []);
        byFile.get(hostPath).push(diag);
    }
    for (const [hostPath, arr] of byFile.entries()) {
        try { diagnosticCollection.set(vscode.Uri.file(hostPath), arr); } catch (e) { /* skip invalid uri */ }
    }
}

async function refreshWebview() {
    if (!currentPanel || !currentFilePath) return;

    currentPanel.title = 'GitLab CI: ' + path.basename(currentFilePath);
    currentPanel.webview.html = getLoadingHtml(currentFilePath);

    try {
        const ciData = await runCiPreview(currentFilePath);
        ciData.ui_lang = resolveLang();
        currentPanel.webview.html = getMainHtml(ciData);
        publishDiagnostics(ciData);
    } catch (err) {
        currentPanel.webview.html = getErrorHtml(currentFilePath, err);
    }
}

function getLoadingHtml(filePath) {
    const fileName = path.basename(filePath);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Loading...</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            height: 100vh; margin: 0;
        }
        .spinner {
            width: 36px; height: 36px; border: 4px solid rgba(255,255,255,0.1);
            border-left-color: #58a6ff; border-radius: 50%;
            animation: spin 1s linear infinite; margin-bottom: 16px;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="spinner"></div>
    <div>${escapeHtml(hm('loading'))} <strong>${escapeHtml(fileName)}</strong>...</div>
</body>
</html>`;
}

function getErrorHtml(filePath, error) {
    const fileName = path.basename(filePath);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Error</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #d4d4d4);
            padding: 30px; line-height: 1.5;
        }
        .error-card {
            background: rgba(244, 67, 54, 0.1);
            border: 1px solid rgba(244, 67, 54, 0.4);
            border-radius: 8px; padding: 20px; max-width: 800px;
        }
        h2 { color: #f44336; margin-top: 0; }
        pre {
            background: rgba(0,0,0,0.3); padding: 12px; border-radius: 4px;
            overflow-x: auto; font-size: 12px; color: #ffb4a9;
        }
        button {
            background: var(--vscode-button-background, #0e639c);
            color: white; border: none; padding: 8px 16px;
            border-radius: 4px; cursor: pointer; font-size: 13px; margin-top: 10px;
        }
    </style>
</head>
<body>
    <div class="error-card">
        <h2>❌ ${escapeHtml(hm('errorTitle'))}</h2>
        <p>File: <strong>${escapeHtml(fileName)}</strong></p>
        <pre>${escapeHtml(String(error))}</pre>
        <button onclick="vscode.postMessage({command: 'refresh'})">🔄 ${escapeHtml(hm('retry'))}</button>
    </div>
    <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
}

function getMainHtml(ciData) {
    const templatePath = path.join(__dirname, 'webview.html');
    let template = fs.readFileSync(templatePath, 'utf-8');
    const safeDataJson = JSON.stringify(ciData).replace(/<\/script>/gi, '<\\/script>');

    // Inline the locally-bundled dagre library so the webview stays 100% offline (CSP-friendly).
    // If the vendor file is missing, fall back to an empty string so we never crash.
    let dagreText = '';
    try {
        const dagrePath = path.join(__dirname, 'vendor', 'dagre.min.js');
        if (fs.existsSync(dagrePath)) {
            dagreText = fs.readFileSync(dagrePath, 'utf-8');
        }
    } catch (e) {
        dagreText = '';
    }

    // Use replacer-function form for both placeholders so `$` patterns in the
    // injected content are treated literally. A placeholder that isn't present
    // in the template simply results in a safe no-op.
    return template
        .replace('__DAGRE_LIB__', () => dagreText)
        .replace('__CI_DATA__', () => safeDataJson);
}

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
