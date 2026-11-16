// Focused documentation/packaging regression for the 0.11.0-beta.1 prerelease.
//
// These checks assert the release-identity and documentation corrections are present
// in the source tree that the packaging builder copies from. They make no model calls
// and touch no runtime state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const EXCLUDED_FROM_EXPORT = ['docs/local-herdr-direct-SKILL.md', 'docs/reports/0.8.1.md'];

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

// Relative link targets inside a Markdown file, ignoring absolute URLs and anchors.
function relativeLinks(file) {
  const targets = [];
  for (const match of readFileSync(file, 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.push(target);
  }
  return targets;
}

test('package and plugin manifests share the 0.11.0-beta.1 prerelease identity', () => {
  const pkg = JSON.parse(read('package.json'));
  const plugin = JSON.parse(read('plugin', 'plugin.json'));
  assert.equal(pkg.version, '0.11.0-beta.1');
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.name, pkg.name);
});

test('compaction integration contract reflects the recorded manual qualification', () => {
  const contract = read('recipes', 'compaction', 'integration-contract.md');
  assert.ok(
    !/no live inference has been run or qualified/.test(contract),
    'stale "never live-tested" wording must be removed',
  );
  assert.match(contract, /docs\/compaction-live-qualification\.md/);
  assert.match(contract, /(synthetic|manual)/i);
  // Dormant/not-auto-wired status and the unqualified automatic path must remain explicit.
  assert.match(contract, /not auto-wired/);
  assert.match(contract, /unqualified/);
  assert.match(contract, /automatic|near-limit/i);
});

test('recipient docs cover quickstart, catalog and troubleshooting', () => {
  for (const doc of ['QUICKSTART.md', 'recipe-catalog.md', 'troubleshooting.md']) {
    assert.ok(existsSync(join(root, 'docs', doc)), `docs/${doc} is required`);
  }
  const quickstart = read('docs', 'QUICKSTART.md');
  assert.match(quickstart, /Node\.js 22\.19/);
  assert.match(quickstart, /credential/i);
  assert.match(quickstart, /chat/i);
  assert.match(quickstart, /disabled by default/i);

  const catalog = read('docs', 'recipe-catalog.md');
  for (const id of ['coding-change', 'research-brief', 'operations-batch']) {
    assert.ok(catalog.includes(id), `recipe catalog must list ${id}`);
  }
  assert.match(catalog, /dormant/i);
  assert.match(catalog, /enabled: false/);

  const troubleshooting = read('docs', 'troubleshooting.md');
  assert.match(troubleshooting, /## Upgrade/);
  assert.match(troubleshooting, /## Rollback/);
  assert.match(troubleshooting, /## Limitations/);
});

test('desk documentation uses one shared Desk space wording', () => {
  const desksReadme = read('examples', 'desks', 'README.md');
  const generalDesks = read('docs', 'general-desks.md');
  for (const [name, text] of [['examples/desks/README.md', desksReadme], ['docs/general-desks.md', generalDesks]]) {
    assert.match(text, /one shared Desk space/i, `${name} must describe one shared Desk space`);
    assert.ok(!/may occupy separate spaces/.test(text), `${name} still claims separate spaces`);
  }
});

test('MIT licensing and public-source policy are present and consistent', () => {
  for (const file of ['LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/public-source-export.md', '.gitignore']) {
    assert.ok(existsSync(join(root, file)), `${file} is required`);
  }
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Herdr/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);

  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
  assert.equal(JSON.parse(read('plugin', 'plugin.json')).license, 'MIT');

  // SECURITY.md must not fabricate a contact address, and must warn against posting secrets.
  const security = read('SECURITY.md');
  assert.match(security, /private vulnerability reporting/i);
  assert.match(security, /open a public issue containing exploit details/i);
  assert.ok(!/@(gmail|outlook|yahoo|proton|example)\./i.test(security), 'must not invent an email contact');
});

test('public source export records its exclusions without rewriting evidence', () => {
  const manifest = read('docs', 'public-source-export.md');
  assert.match(manifest, /gfgdev\/herdr-codex/);
  assert.match(manifest, /https:\/\/github\.com\/gfgdev\/herdr-codex/);
  assert.doesNotMatch(manifest, /planned|pending verification|targeted at/i);
  for (const excluded of ['inputs/', 'local-herdr-direct-SKILL.md', '0.2.1.md', '0.8.1.md']) {
    assert.ok(manifest.includes(excluded), `export manifest must list ${excluded}`);
  }
  assert.match(manifest, /Runnable after clone|runnable/i);
  assert.match(manifest, /Recorded evidence only/i);

  for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    const text = read(file);
    assert.match(text, /https:\/\/github\.com\/gfgdev\/herdr-codex/, `${file} must link the repository`);
    assert.doesNotMatch(
      text,
      /planned|pending verification|targeted at `?gfgdev/i,
      `${file} must describe the verified destination, not a planned one`,
    );
  }
  assert.match(read('README.md'), /gfgdev\/herdr-codex\/releases/, 'README must link the releases page');

  const ignore = read('.gitignore');
  for (const pattern of ['inputs/', 'docs/local-herdr-direct-SKILL.md', 'docs/reports/0.8.1.md']) {
    assert.ok(ignore.includes(pattern), `.gitignore must exclude ${pattern}`);
  }

  // The exclusion contract must stay decidable in a public clone, where the private
  // files were deliberately never exported. So this does NOT require them to exist.
  // It asserts the exported tree has no link pointing at an excluded path, and that the
  // source-layout catalog links resolve in this checkout.
  for (const relativePath of EXCLUDED_FROM_EXPORT) {
    const localPath = join(root, relativePath);
    if (existsSync(localPath)) {
      assert.ok(statSync(localPath).isFile(), `${relativePath} must remain a file locally`);
    }
  }
  const exportedDocs = [join(root, 'README.md'), join(root, 'CHANGELOG.md'), ...markdownFiles(join(root, 'docs'))]
    .filter(file => !EXCLUDED_FROM_EXPORT.some(excluded => file === join(root, excluded)))
    .filter(file => !file.startsWith(join(root, 'inputs') + '/'));
  for (const file of exportedDocs) {
    for (const target of relativeLinks(file)) {
      const resolved = resolve(dirname(file), target);
      assert.ok(
        !EXCLUDED_FROM_EXPORT.some(excluded => resolved === join(root, excluded)),
        `${relative(file, root)} links to excluded local-only evidence: ${target}`,
      );
      assert.ok(
        !resolved.startsWith(join(root, 'inputs') + '/'),
        `${relative(file, root)} links into local-only inputs/: ${target}`,
      );
    }
  }

  // Source layout: the catalog must link at the checkout's `recipes/compaction/` assets.
  const catalogPath = join(root, 'docs', 'recipe-catalog.md');
  const catalogLinks = relativeLinks(catalogPath).filter(target => /compaction/.test(target));
  assert.ok(catalogLinks.length >= 3, 'recipe catalog must link its compaction assets');
  for (const target of catalogLinks) {
    assert.ok(
      existsSync(resolve(dirname(catalogPath), target)),
      `recipe catalog link must resolve in the source checkout: ${target}`,
    );
  }
});

test('qualification harnesses are portable and fixtures use generic paths', () => {
  // Built from parts so this regression file itself contains no personal path literal.
  const homePrefix = ['/Users', 'paulsmith'].join('/');
  for (const script of ['qualify-compaction-session.mjs', 'qualify-goose-pi.mjs', 'goose-smoke.mjs']) {
    const text = read('scripts', script);
    assert.ok(!text.includes(homePrefix), `${script} must not hard-code a machine path`);
  }
  assert.match(read('scripts', 'qualify-compaction-session.mjs'), /PI_CODING_AGENT_DIST/);
  assert.match(read('scripts', 'qualify-goose-pi.mjs'), /GOOSE_BIN/);
  assert.match(read('scripts', 'goose-smoke.mjs'), /GOOSE_BIN/);

  for (const fixture of ['recipes/compaction/fixtures/input-slice.json', 'tests/fixtures/compaction/preparation-simple.json']) {
    const text = read(...fixture.split('/'));
    assert.ok(!text.includes(homePrefix), `${fixture} must not contain a personal path`);
    assert.match(text, /\/synthetic\/example\/project/);
  }
});
