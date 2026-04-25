'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SHARED_EXT_DIR = process.env.SHARED_EXT_DIR || '/opt/shared-extensions';

// id: publisher.name или publisher.name@version, либо абсолютный путь до .vsix
const EXT_ID_RE = /^[a-zA-Z0-9][\w.-]*\.[a-zA-Z0-9][\w.-]*(@[\w.+-]+)?$/;

function runCodeServer(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('code-server', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EXTENSIONS_GALLERY: JSON.stringify({
          serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery',
          cacheUrl: 'https://vscode.blob.core.windows.net/gallery/index',
          itemUrl: 'https://marketplace.visualstudio.com/items',
        }),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('code-server command timed out'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`code-server exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

class ExtensionManager {
  async list() {
    fs.mkdirSync(SHARED_EXT_DIR, { recursive: true });
    const { stdout } = await runCodeServer([
      '--list-extensions', '--show-versions',
      '--extensions-dir', SHARED_EXT_DIR
    ]);
    return stdout.split('\n').map(s => s.trim()).filter(Boolean).map(line => {
      const at = line.lastIndexOf('@');
      return at > 0
        ? { id: line.slice(0, at), version: line.slice(at + 1) }
        : { id: line, version: null };
    });
  }

  async install(id) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Extension id is required');
    id = id.trim();
    const isVsixPath = id.endsWith('.vsix') && path.isAbsolute(id) && fs.existsSync(id);
    if (!isVsixPath && !EXT_ID_RE.test(id)) {
      throw new Error('Invalid extension id. Expected "publisher.name" or "publisher.name@version" or an absolute .vsix path');
    }
    fs.mkdirSync(SHARED_EXT_DIR, { recursive: true });
    const { stdout, stderr } = await runCodeServer([
      '--install-extension', id,
      '--force',
      '--extensions-dir', SHARED_EXT_DIR
    ]);
    return { id, stdout: stdout.trim(), stderr: stderr.trim() };
  }

  async uninstall(id) {
    if (!EXT_ID_RE.test(id)) throw new Error('Invalid extension id');
    const { stdout, stderr } = await runCodeServer([
      '--uninstall-extension', id,
      '--extensions-dir', SHARED_EXT_DIR
    ]);
    return { id, stdout: stdout.trim(), stderr: stderr.trim() };
  }
}

module.exports = new ExtensionManager();
