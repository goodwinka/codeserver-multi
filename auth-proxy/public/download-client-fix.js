/* Injected by auth-proxy: fix absolute entry paths in client-side ZIP blobs.
 * VS Code creates ZIP archives entirely in the browser (Blob URL). When entry
 * paths start with '/' Chrome's built-in ZIP viewer refuses to open the file
 * ("contains system files"). We intercept <a>.click() for blob: zip downloads
 * and repack the archive with relative paths before triggering the save. */
(function () {
  'use strict';

  if (typeof fflate === 'undefined') {
    console.warn('[download-fix] fflate not available; client-side fix skipped');
    return;
  }

  /* Blob URLs we're currently processing — delay revokeObjectURL for these. */
  var pending = new Set();

  var _origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function (url) {
    if (pending.has(url)) return; /* deferred until repack completes */
    return _origRevoke(url);
  };

  var _origClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function () {
    var el = this;
    var href     = el.href || '';
    var download = el.getAttribute && (el.getAttribute('download') || '');

    if (
      el.tagName !== 'A' ||
      !href.startsWith('blob:') ||
      !download.toLowerCase().endsWith('.zip')
    ) {
      return _origClick.call(el);
    }

    pending.add(href);

    fetch(href)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) {
        return new Promise(function (resolve, reject) {
          fflate.unzip(new Uint8Array(buf), function (err, files) {
            if (err) return reject(err);

            var hasAbsolute = false;
            var fixed = {};

            Object.keys(files).forEach(function (p) {
              if (p.charAt(0) === '/' || p.charAt(0) === '\\') hasAbsolute = true;
              var fp = p.replace(/^[/\\]+/, '');
              if (fp) fixed[fp] = files[p];
            });

            if (!hasAbsolute) {
              /* Nothing to fix – pass through */
              pending.delete(href);
              _origRevoke(href);
              _origClick.call(el);
              return resolve(null);
            }

            fflate.zip(fixed, function (err2, zipped) {
              if (err2) return reject(err2);
              resolve(zipped);
            });
          });
        });
      })
      .then(function (zipped) {
        if (zipped === null) return;
        pending.delete(href);
        _origRevoke(href);

        var blob   = new Blob([zipped], { type: 'application/zip' });
        var newUrl = URL.createObjectURL(blob);
        var a      = document.createElement('a');
        a.href     = newUrl;
        a.download = download;
        document.body.appendChild(a);
        _origClick.call(a);
        document.body.removeChild(a);
        URL.revokeObjectURL(newUrl);
      })
      .catch(function (err) {
        console.error('[download-fix] repack failed:', err);
        pending.delete(href);
        _origClick.call(el); /* fallback to original download */
      });
  };

  console.log('[download-fix] client-side ZIP path fix active');
}());
