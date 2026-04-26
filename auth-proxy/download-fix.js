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

function detectArchiveType(proxyRes) {
  const cd = proxyRes.headers['content-disposition'] || '';
  if (!cd.toLowerCase().includes('attachment')) return null;
  const f = parseFilename(cd);
  if (f.endsWith('.tar.gz') || f.endsWith('.tgz')) return 'tar.gz';
  if (f.endsWith('.tar')) return 'tar';
  if (f.endsWith('.zip')) return 'zip';
  return null;
}

// Strip leading slashes/backslashes to turn absolute archive paths into relative ones.
function fixEntryPath(p) {
  return p.replace(/^[/\\]+/, '');
}

function interceptTar(proxyRes, res, isGzip) {
  const tar = getTar();
  if (!tar) return false;

  // Remove content-length — repacked archive size differs
  delete proxyRes.headers['content-length'];

  // Override pipe so we can intercept when http-proxy calls proxyRes.pipe(res)
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

    // Buffer the whole zip, repack with relative paths, send
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
          try {
            res.setHeader('content-length', zipped.length);
          } catch (_) {}
          res.end(Buffer.from(zipped));
        });
      });
    });

    return dest;
  };

  return true;
}

/**
 * Attach to an http-proxy instance to intercept tar/zip folder downloads
 * and rewrite archive entry paths to be relative (strip leading '/').
 * Fixes the "contains system files" error shown by browsers / Windows when
 * code-server serves archives with absolute entry paths.
 */
function setupDownloadFix(proxy) {
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
}

module.exports = { setupDownloadFix };
