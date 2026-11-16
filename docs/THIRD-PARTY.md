# Third-party notices

## js-yaml — bundled ESM-compatible copy

`src/vendor-js-yaml.mjs` is a **bundled, ESM-compatible adaptation** of the js-yaml YAML
library, not a byte-for-byte copy of the upstream distribution. The bundled file wraps the
upstream code in a CommonJS-interop helper (`getDefaultExportFromCjs`) and lazy
`require*()` initializers so the library can be imported directly as an ES module. Its
final line is an upstream `//# sourceMappingURL=js-yaml.mjs.map` comment; the referenced
source map is not shipped, so that comment is a dangling reference. This is cosmetic — the
bundled copy still parses normally — and the copy is never downloaded or rebuilt at
runtime; no runtime fetch or network access is required.

Upstream source project: https://github.com/nodeca/js-yaml

**Recorded provenance, not independently verified.** This copy was recorded as js-yaml
4.3.2 when it was added to the tree. The bundled file contains no version string, and no
upstream distribution archive, registry metadata or upstream checksum was retained with it,
so that version cannot be re-derived from this repository and is *recorded provenance*
only. Identify the copy bundled in this release by its own content hash instead:

- `src/vendor-js-yaml.mjs` SHA-256
  `cea276c7e15f409a1adbe5d177aba7824398a474f7cf702bd57962c7d570636f`
- (the same file ships at `plugins/herdr-codex/runtime/src/vendor-js-yaml.mjs`)

The upstream MIT license text is retained verbatim below.

(The MIT License)

Copyright (C) 2011-2015 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
