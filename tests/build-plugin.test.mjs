// Focused packaging regression for scripts/build-plugin.mjs.
//
// The 0.10.0 release ships the bounded-compaction recipe as a documented example
// only. This test builds a real package into a scratch folder (no model calls) and
// asserts the four reviewed assets travel byte-for-byte, that no fixture tree is
// packaged, and that the embedded tool-discovery/compaction-asset checks ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const COMPACTION_EXAMPLE_ASSETS = [
  'recipe.yaml',
  'schema/summary-candidate.schema.json',
  'lib/param-encode.mjs',
  'integration-contract.md',
];

test('build-plugin ships the dormant compaction example with 16-tool discovery', () => {
  // Canonicalize the scratch root: on macOS `os.tmpdir()` returns a logical
  // `/var/folders/...` path whose real path is `/private/var/folders/...`. The packaged
  // agent-MCP wrapper resolves its own location via `import.meta.url` (already canonical),
  // so the builder's argv equality check would compare the logical `--out` path against the
  // real path, refuse to launch, emit empty stdout and break the JSON.parse below.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-build-plugin-')));
  const out = join(base, 'share');
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'build-plugin.mjs'), '--out', out], {
      cwd: root, encoding: 'utf8',
    });
    const result = JSON.parse(stdout);
    assert.equal(result.version, pkg.version);
    assert.equal(result.modelCalls, 0);
    assert.equal(result.packagedCliHelp, true);
    assert.equal(result.packagedMcpDiscovery, true);

    const manifest = JSON.parse(readFileSync(join(out, 'BUILD-MANIFEST.json'), 'utf8'));
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.checked.packagedCompactionAssets, true);
    assert.equal(manifest.checked.packagedCompactionImports, true);

    const exampleDir = join(out, 'plugins', 'herdr-codex', 'examples', 'compaction');
    for (const asset of COMPACTION_EXAMPLE_ASSETS) {
      const packaged = join(exampleDir, asset);
      assert.ok(existsSync(packaged), `packaged compaction asset is missing: ${asset}`);
      assert.deepEqual(
        readFileSync(packaged),
        readFileSync(join(root, 'recipes', 'compaction', asset)),
        `packaged copy differs from source: ${asset}`,
      );
    }

    assert.ok(!existsSync(join(exampleDir, 'fixtures')), 'compaction fixture tree must not be packaged');
    assert.ok(
      !manifest.files.some(file => /examples\/compaction\/(fixtures|tests|__pycache__)\//.test(file.path)),
      'compaction fixtures/tests must not appear in the artifact inventory',
    );

    // 0.11.0-beta.1 recipient documentation must travel with the plugin and be
    // reachable from the generated artifact README.
    const packagedDocs = join(out, 'plugins', 'herdr-codex', 'docs');
    for (const doc of ['QUICKSTART.md', 'recipe-catalog.md', 'troubleshooting.md']) {
      assert.ok(existsSync(join(packagedDocs, doc)), `packaged recipient document is missing: ${doc}`);
    }
    const artifactReadme = readFileSync(join(out, 'README.md'), 'utf8');
    assert.match(artifactReadme, /QUICKSTART\.md/);
    assert.match(artifactReadme, /recipe-catalog\.md/);
    assert.match(artifactReadme, /troubleshooting\.md/);
    assert.match(artifactReadme, /one shared Desk space/i);

    // The packaged catalog must link the artifact's own example layout. The source
    // checkout keeps these assets in `recipes/compaction/`, so the builder rewrites the
    // catalog links; a packaged document must never point at the source-only path.
    const packagedCatalog = readFileSync(join(packagedDocs, 'recipe-catalog.md'), 'utf8');
    assert.ok(
      !packagedCatalog.includes('../recipes/compaction/'),
      'packaged catalog must not reference the source-only recipes/compaction layout',
    );
    for (const asset of ['recipe.yaml', 'schema/summary-candidate.schema.json', 'integration-contract.md']) {
      assert.ok(
        packagedCatalog.includes(`../examples/compaction/${asset}`),
        `packaged catalog must link its own examples/compaction/${asset}`,
      );
    }

    // Public-source licensing/contribution documents must travel with the plugin.
    const pluginDir = join(out, 'plugins', 'herdr-codex');
    for (const doc of ['LICENSE', 'CONTRIBUTING.md', 'SECURITY.md']) {
      assert.ok(existsSync(join(pluginDir, doc)), `packaged public-source document is missing: ${doc}`);
    }
    const packagedLicense = readFileSync(join(pluginDir, 'LICENSE'), 'utf8');
    assert.match(packagedLicense, /^MIT License/);
    assert.match(packagedLicense, /Copyright \(c\) 2026 Herdr/);
    // Package license metadata is present and consistent.
    assert.equal(pkg.license, 'MIT');
    const runtimePkg = JSON.parse(readFileSync(join(pluginDir, 'runtime', 'package.json'), 'utf8'));
    assert.equal(runtimePkg.license, 'MIT');
    assert.match(readFileSync(join(pluginDir, 'docs', 'THIRD-PARTY.md'), 'utf8'), /js-yaml/);

    // The packaged launcher is the supported entry point and must be executable.
    const launcher = join(pluginDir, 'scripts', 'herdr-codex.sh');
    assert.ok(existsSync(launcher), 'packaged launcher is missing');
    assert.ok((statSync(launcher).mode & 0o100) !== 0, 'packaged launcher must be executable');

    // The artifact README documents the installed (packaged) entry point, never a source path.
    assert.ok(!/\bnode src\/cli\.mjs\b/.test(artifactReadme), 'artifact README must not use a source-only CLI path');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
