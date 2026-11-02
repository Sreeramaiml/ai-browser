# Vendored libraries

Third-party code is copied here (not loaded from a CDN) because MV3 extensions can't run remote code. Every file is pinned to an exact version. Check for security releases before each Sahayak release, especially DOMPurify.

| File | Library | Version | Source (npm tarball path) | License | Used by |
|------|---------|---------|---------------------------|---------|---------|
| `Readability.js` | [@mozilla/readability](https://github.com/mozilla/readability) | 0.6.0 | `package/Readability.js` | Apache-2.0 | Content scripts (classic script, defines `Readability`) |
| `Readability-readerable.js` | @mozilla/readability | 0.6.0 | `package/Readability-readerable.js` | Apache-2.0 | Content scripts (classic script, defines `isProbablyReaderable`) |
| `marked.esm.js` | [marked](https://github.com/markedjs/marked) | 18.1.1 | `package/lib/marked.esm.js` | MIT | Side panel (ES module) |
| `purify.es.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | `package/dist/purify.es.mjs` (renamed to `.js`) | Apache-2.0 OR MPL-2.0 | Side panel (ES module) |

License texts are in [`licenses/`](licenses/).

## Local modifications

- `marked.esm.js` and `purify.es.js`: the trailing `//# sourceMappingURL=…` line was removed, because the `.map` files aren't vendored and DevTools would warn about them.
- `purify.es.mjs` was renamed to `purify.es.js` so Chrome serves it with a JavaScript MIME type from the extension package.

No other changes. The SHA-256 hashes of the vendored files:

```
34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174  Readability.js
a98d28805804c1986ceed470678a3f409f150ee7f1d227f8c8239c005d21de65  Readability-readerable.js
3131eb6f6cc1711da76e7847e11a2f07d0957f5ecf32a3ceb58e98d72859f5f3  marked.esm.js
a23ba9b1063ff7f345fca86a1380cf144b2c26083c73b66e200d20b4a07d8ea0  purify.es.js
```

## Updating a library

1. Download the tarball: `curl -sL https://registry.npmjs.org/<pkg>/-/<name>-<version>.tgz | tar xz -C <empty-temp-dir>`
2. Copy the file listed above, and remove the `sourceMappingURL` line if there is one.
3. Update the version and hash in this file and the version assertion in `tests/vendor.test.js`.
4. Run `npm test`, then reload the extension and re-check every feature that uses the library.
