/** @file Exercises plugin metadata drift and immutable publication checks using isolated package and Git fixtures. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMarketplaceEntry, validatePlugin } from './calibrate-plugin.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = 'plugins/calibrate-health';
const sourceUrl = 'ssh://git@github.com/MChartier/calibrate-health.git';

/** Copy only owned package inputs; fixture mutations never touch the checkout or user's Git config. */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'calibrate-plugin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'plugins'));
  await cp(path.join(repositoryRoot, packagePath), path.join(root, packagePath), { recursive: true });
  for (const filename of ['LICENSE', 'NOTICE', '.gitattributes']) {
    await copyFile(path.join(repositoryRoot, filename), path.join(root, filename));
  }
  return root;
}

/** Rewrite one fixture JSON object for validation-failure coverage. */
async function editJson(root, filename, change) {
  const target = path.join(root, packagePath, filename);
  const contents = JSON.parse(await readFile(target, 'utf8'));
  change(contents);
  await writeFile(target, JSON.stringify(contents));
}

/** Run Git strictly inside the temporary fixture with deterministic per-command author identity. */
function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Plugin Fixture', '-c', 'user.email=plugin-fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Commit a real fixture tree so content matching and ancestry exercise Git rather than mock algorithms. */
async function committedFixture(t) {
  const root = await fixture(t);
  git(root, ['init', '--quiet']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return { root, ref: git(root, ['rev-parse', 'HEAD']).trim() };
}

/** Stub only network discovery; all local commit, tree, byte-hash, and ancestry checks use real Git. */
function publishedRunner(advertised, calls = []) {
  return (root, args) => {
    calls.push(args);
    if (args[0] === 'ls-remote') {
      assert.deepEqual(args, ['ls-remote', sourceUrl]);
      return advertised;
    }
    return git(root, args);
  };
}

test('check works in a package fixture without Git or a published commit', async (t) => {
  const manifest = await validatePlugin(await fixture(t));
  assert.equal(manifest.name, 'calibrate-health');
  assert.equal(manifest.license, 'PolyForm-Shield-1.0.0');
  assert.deepEqual(manifest.interface.capabilities, ['Interactive', 'Read']);
});

test('check rejects package metadata and OAuth drift', async (t) => {
  const cases = [
    ['name', (value) => { value.name = 'other'; }, /Plugin name/],
    ['version', (value) => { value.version = 'latest'; }, /semantic version/],
    ['license', (value) => { value.license = 'Apache-2.0'; }, /license must/],
    ['write capability', (value) => { value.interface.capabilities.push('Write'); }, /capabilities/],
    ['empty prompt', (value) => { value.interface.defaultPrompt = ['']; }, /discovery prompts/],
    ['insecure metadata', (value) => { value.homepage = 'http://calibratehealth.app'; }, /HTTPS/],
    ['escaping path', (value) => { value.mcpServers = './../outside.json'; }, /Invalid plugin path/],
  ];
  for (const [name, change, expected] of cases) {
    await t.test(name, async (subtest) => {
      const root = await fixture(subtest);
      await editJson(root, '.codex-plugin/plugin.json', change);
      await assert.rejects(validatePlugin(root), expected);
    });
  }
  await t.test('static credential', async (subtest) => {
    const root = await fixture(subtest);
    await editJson(root, '.mcp.json', (value) => { value.mcpServers.calibrate.headers = { Authorization: 'Bearer fixture-only' }; });
    await assert.rejects(validatePlugin(root), /credentials belong in the host OAuth flow/);
  });
  await t.test('missing OAuth', async (subtest) => {
    const root = await fixture(subtest);
    await editJson(root, '.mcp.json', (value) => { delete value.mcpServers.calibrate.auth; });
    await assert.rejects(validatePlugin(root), /must use HTTP OAuth/);
  });
});

test('check rejects inconsistent skill endpoints, missing tool guidance, and distribution notices', async (t) => {
  const cases = [
    ['skills/calibrate-progress/agents/openai.yaml', (text) => text.replace('https://calibratehealth.darkmachines.net/mcp', 'https://example.invalid/mcp'), /dependency must match/],
    ['skills/calibrate-progress/SKILL.md', (text) => text.replaceAll('`compare_progress_periods`', '`unknown_tool`'), /must describe compare_progress_periods/],
    ['LICENSE', () => 'not the repository license', /LICENSE must match/],
    ['NOTICE', () => 'not the required copyright notice', /NOTICE must match/],
  ];
  for (const [filename, change, expected] of cases) {
    await t.test(filename, async (subtest) => {
      const root = await fixture(subtest);
      const target = path.join(root, packagePath, filename);
      await writeFile(target, change(await readFile(target, 'utf8')));
      await assert.rejects(validatePlugin(root), expected);
    });
  }
});

test('marketplace entry preserves the catalog schema and only uses read-only Git operations', async (t) => {
  const { root, ref } = await committedFixture(t);
  const calls = [];
  const entry = await createMarketplaceEntry({ root, ref, gitRunner: publishedRunner(`${ref}\trefs/heads/master\n`, calls) });
  assert.deepEqual(entry, {
    name: 'calibrate-health',
    source: { source: 'git-subdir', url: sourceUrl, path: './plugins/calibrate-health', ref },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  });
  assert.ok(calls.every(([command]) => ['cat-file', 'ls-tree', 'hash-object', 'ls-remote', 'merge-base'].includes(command)));
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('publication accepts a source commit that is an ancestor of an advertised branch', async (t) => {
  const { root, ref } = await committedFixture(t);
  await writeFile(path.join(root, 'unrelated.txt'), 'later commit');
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'unrelated']);
  const tip = git(root, ['rev-parse', 'HEAD']).trim();
  const entry = await createMarketplaceEntry({ root, ref, gitRunner: publishedRunner(`${tip}\trefs/heads/master\n`) });
  assert.equal(entry.source.ref, ref);
});

test('publication accepts Windows text line endings normalized by repository attributes', async (t) => {
  const { root, ref } = await committedFixture(t);
  const filename = path.join(root, packagePath, 'README.md');
  const contents = await readFile(filename, 'utf8');
  await writeFile(filename, contents.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
  const entry = await createMarketplaceEntry({ root, ref, gitRunner: publishedRunner(`${ref}\trefs/heads/master\n`) });
  assert.equal(entry.source.ref, ref);
});

test('publication rejects mutable refs and unknown or unpublished commits', async (t) => {
  const { root, ref } = await committedFixture(t);
  for (const invalid of ['master', 'v1.1.0', ref.slice(0, 8), `${ref}~1`]) {
    await assert.rejects(createMarketplaceEntry({ root, ref: invalid }), /full lowercase 40-character commit SHA/);
  }
  await assert.rejects(createMarketplaceEntry({ root, ref: 'f'.repeat(40), gitRunner: publishedRunner('') }), /git|bad object/i);
  await assert.rejects(createMarketplaceEntry({ root, ref, gitRunner: publishedRunner('') }), /not verifiably reachable/);
});

test('publication rejects changed, omitted, and extra package files before querying the remote', async (t) => {
  for (const mutation of ['changed', 'omitted', 'extra']) {
    await t.test(mutation, async (subtest) => {
      const { root, ref } = await committedFixture(subtest);
      if (mutation === 'changed') await editJson(root, '.codex-plugin/plugin.json', (value) => { value.version = '1.2.0'; });
      if (mutation === 'omitted') await rm(path.join(root, packagePath, 'README.md'));
      if (mutation === 'extra') await writeFile(path.join(root, packagePath, 'untracked.txt'), 'uncommitted');
      const calls = [];
      await assert.rejects(createMarketplaceEntry({ root, ref, gitRunner: publishedRunner(`${ref}\tHEAD\n`, calls) }), /Source revision (differs|must include)/);
      assert.ok(calls.every(([command]) => command !== 'ls-remote'));
    });
  }
});

test('publication reports remote access failure without exposing credential output', async (t) => {
  const { root, ref } = await committedFixture(t);
  const gitRunner = (directory, args) => {
    if (args[0] === 'ls-remote') throw new Error('sensitive fixture output');
    return git(directory, args);
  };
  await assert.rejects(createMarketplaceEntry({ root, ref, gitRunner }), (error) => {
    assert.match(error.message, /check Git\/SSH access/);
    assert.doesNotMatch(error.message, /sensitive fixture output/);
    return true;
  });
});
