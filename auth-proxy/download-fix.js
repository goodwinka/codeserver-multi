'use strict';

const zlib = require('zlib');

// Lazy-load to avoid startup crash when packages are absent during development
function getTar() {
  try { return require('tar-stream'); } catch (_) { return null; }
}
function getFflate() {
  try { return require('fflate'); } catch (_) { return null; }
}

function parseFilename(cd) {
  // Handles: filename="foo.tar.gz", filename=foo.tar.gz, filename*=UTF-8''foo.tar.gz
  const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]*)["']?/i);
  return m ? decodeURIComponent(m[1].trim()) : '';
}

// Detect archive type from Content-Disposition or Content-Type.
function detectArchiveType(proxyRes) {
  const cd = proxyRes.headers['content-disposition'] || '';
  const ct = proxyRes.headers['content-type'] || '';

  if (cd.toLowerCase().includes('attachment')) {
    const f = parseFilename(cd);
    if (f.endsWith('.tar.gz') || f.endsWith('.tgz')) return 'tar.gz';
    if (f.endsWith('.tar'))                           return 'tar';
    if (f.endsWith('.zip'))                           return 'zip';
  }

  // Fallback: Content-Type alone (no filename in disposition)
  if (/application\/(zip|x-zip(-compressed)?)/.test(ct))        return 'zip';
  if (/application\/(x-tar|x-gtar)/.test(ct))                   return 'tar';
  if (/application\/(gzip|x-gzip)/.test(ct) && cd.includes('attachment')) return 'tar.gz';

  return null;
}

// Strip leading slashes/backslashes → relative paths.
function fixEntryPath(p) {
  return p.replace(/^[/\\]+/, '');
}

// ── Server-side interceptors ────────────────────────────────────────────────

function interceptTar(proxyRes, res, isGzip) {
  const tar = getTar();
  if (!tar) return false;

  delete proxyRes.headers['content-length'];

  const _origPipe = proxyRes.pipe.bind(proxyRes);
  proxyRes.pipe = function (dest, opts) {
    if (dest !== res) return _origPipe(dest, opts);

    const extract = tar.extract();
    const pack    = tar.pack();

    extract.on('entry', (header, stream, next) => {
      header.name = fixEntryPath(header.name);
      if (header.linkname) header.linkname = fixEntryPath(header.linkname);
      if (!header.name) { stream.resume(); return next(); }
      pack.entry(header, stream, next);
    });
    extract.on('finish', () => pack.finalize());
    extract.on('error', (err) => {
      console.error('[download-fix] tar.extract error:', err.message);
      try { pack.destroy(); } catch (_) {}
      try { res.destroy(); } catch (_) {}
    });

    if (isGzip) {
      const gunzip = zlib.createGunzip();
      const gzip   = zlib.createGzip();
      gunzip.on('error', (err) => {
        console.error('[download-fix] gunzip error:', err.message);
        try { res.destroy(); } catch (_) {}
      });
      pack.pipe(gzip).pipe(res);
      _origPipe(gunzip);
      gunzip.pipe(extract);
    } else {
      pack.pipe(res);
      _origPipe(extract);
    }

    return dest;
  };

  return true;
}

function interceptZip(proxyRes, res) {
  const fflate = getFflate();
  if (!fflate) return false;

  delete proxyRes.headers['content-length'];

  const _origPipe = proxyRes.pipe.bind(proxyRes);
  proxyRes.pipe = function (dest, opts) {
    if (dest !== res) return _origPipe(dest, opts);

    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(chunk));
    proxyRes.on('error', (err) => {
      console.error('[download-fix] proxyRes error (zip):', err.message);
      try { res.destroy(); } catch (_) {}
    });
    proxyRes.on('end', () => {
      const data = new Uint8Array(Buffer.concat(chunks));
      fflate.unzip(data, (err, files) => {
        if (err) {
          console.error('[download-fix] fflate.unzip error:', err.message);
          try { res.destroy(); } catch (_) {}
          return;
        }
        const fixed = {};
        for (const [p, content] of Object.entries(files)) {
          const fp = fixEntryPath(p);
          if (fp) fixed[fp] = content;
        }
        fflate.zip(fixed, (err2, zipped) => {
          if (err2) {
            console.error('[download-fix] fflate.zip error:', err2.message);
            try { res.destroy(); } catch (_) {}
            return;
          }
          try { res.setHeader('content-length', zipped.length); } catch (_) {}
          res.end(Buffer.from(zipped));
        });
      });
    });

    return dest;
  };

  return true;
}

// ── Client-side HTML injection ──────────────────────────────────────────────
//
// VS Code creates ZIP archives entirely in the browser (Blob URL), so the
// proxy never sees the final archive. We inject fflate + download-client-fix.js
// into every HTML page served by code-server. The client script patches
// <a>.click() for blob: ZIP downloads and repacks with relative paths.

function injectScripts(html, nonce) {
  const na  = nonce ? ` nonce="${nonce}"` : '';
  const tag =
    `<script${na} src="/_auth/static/fflate.js"></script>` +
    `<script${na} src="/_auth/static/download-client-fix.js"></script>`;
  if (html.includes('</body>')) return html.replace('</body>', tag + '\n</body>');
  if (html.includes('</html>')) return html.replace('</html>', tag + '\n</html>');
  return html + '\n' + tag;
}

function setupHtmlInjection(proxy) {
  proxy.on('proxyRes', (proxyRes, req, res) => {
    const ct = proxyRes.headers['content-type'] || '';
    if (!ct.includes('text/html'))   return;
    if (proxyRes.statusCode !== 200) return;

    const enc = (proxyRes.headers['content-encoding'] || '').toLowerCase();

    // We'll send uncompressed — remove encoding header so client doesn't try to decompress
    delete proxyRes.headers['content-encoding'];
    delete proxyRes.headers['content-length'];

    const _origPipe = proxyRes.pipe.bind(proxyRes);
    proxyRes.pipe = function (dest, opts) {
      if (dest !== res) return _origPipe(dest, opts);

      const chunks = [];

      function finish() {
        const raw  = Buffer.concat(chunks).toString('utf8');
        // Extract nonce from the first script tag that has one (VS Code CSP)
        const nm   = raw.match(/\bnonce="([^"]+)"/);
        const html = injectScripts(raw, nm ? nm[1] : '');
        res.end(html);
      }

      function onErr(label, err) {
        console.error(`[download-fix] html-inject ${label}:`, err.message);
        try { res.destroy(); } catch (_) {}
      }

      if (enc === 'gzip' || enc === 'x-gzip') {
        const gz = zlib.createGunzip();
        gz.on('data', c => chunks.push(c));
        gz.on('end',  finish);
        gz.on('error', e => onErr('gunzip', e));
        _origPipe(gz);
      } else if (enc === 'br') {
        const br = zlib.createBrotliDecompress();
        br.on('data', c => chunks.push(c));
        br.on('end',  finish);
        br.on('error', e => onErr('brotli', e));
        _origPipe(br);
      } else {
        proxyRes.on('data',  c => chunks.push(c));
        proxyRes.on('end',   finish);
        proxyRes.on('error', e => onErr('stream', e));
      }

      return dest;
    };
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

function setupDownloadFix(proxy) {
  // 1. Server-side: repack tar/zip archives that come through as HTTP responses
  proxy.on('proxyRes', (proxyRes, req, res) => {
    const type = detectArchiveType(proxyRes);
    if (!type) return;

    const filename = parseFilename(proxyRes.headers['content-disposition'] || '');
    let handled = false;

    if (type === 'tar.gz') handled = interceptTar(proxyRes, res, true);
    else if (type === 'tar')    handled = interceptTar(proxyRes, res, false);
    else if (type === 'zip')    handled = interceptZip(proxyRes, res);

    if (handled) {
      console.log(`[download-fix] rewriting paths in ${type} download: ${filename}`);
    }
  });

  // 2. Client-side: inject fflate + fix script into every HTML page
  setupHtmlInjection(proxy);
}

module.exports = { setupDownloadFix };
