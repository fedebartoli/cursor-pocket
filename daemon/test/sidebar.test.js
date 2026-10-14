import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stringHash } from '../src/cursor/hash.js';
import { collapsedIds, orderSections } from '../src/cursor/sidebar.js';
import { HOME_KEY, WorkspaceResolver, sectionIdFor, uriToPath } from '../src/cursor/workspaces.js';
import { tmpDir } from './helpers/fixture.js';

test('VS Code hash: values computed with Python implementation validated against real Cursor section ids', () => {
  // Samples are synthetic; expected values come from research/phase0_sidebar_order.py (vs_hash_str),
  // which in Phase 0 reproduced section ids saved by Cursor.
  const vectors = {
    'local:home': 1773526007,
    'local:path:/Users/demo/progetto': -444033001,
    'local:path:/Users/demo/Progetto Pi\u00f9/\u00e8\u00e0': 1232003952,
    '': 149417,
    a: 4632024,
    'local:path:/tmp/\ud83d\ude00emoji': 1271121241,
  };
  for (const [s, v] of Object.entries(vectors)) assert.equal(stringHash(s), v, JSON.stringify(s));
  assert.equal(sectionIdFor(HOME_KEY), '__environment_instance_1773526007__');
});

test('uriToPath: VS Code URI objects, file:// strings and remote schemes', () => {
  assert.equal(uriToPath({ $mid: 1, scheme: 'file', path: '/Users/demo/a b' }), '/Users/demo/a b');
  assert.equal(uriToPath({ external: 'file:///Users/demo/Progetto%20Pi%C3%B9' }), '/Users/demo/Progetto Pi\u00f9');
  assert.equal(uriToPath('file:///Users/demo/app'), '/Users/demo/app');
  assert.equal(uriToPath({ scheme: 'vscode-remote', path: '/home/x' }), null);
  assert.equal(uriToPath('https://example.com/x'), null);
  assert.equal(uriToPath(null), null);
});

test('WorkspaceResolver: priority agentLocation > workspaceIdentifier > workspace.json > home', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'ws-a'));
  fs.writeFileSync(path.join(dir, 'ws-a', 'workspace.json'), JSON.stringify({ folder: 'file:///Users/demo/da-storage' }));
  fs.mkdirSync(path.join(dir, 'ws-multi'));
  fs.writeFileSync(path.join(dir, 'ws-multi', 'workspace.json'), JSON.stringify({ workspace: 'file:///Users/demo/mio.code-workspace' }));
  const r = new WorkspaceResolver({ dir });

  const fromLocation = r.resolve({ workspaceId: 'ws-a', header: { agentLocation: { type: 'local', environment: { uri: { scheme: 'file', path: '/Users/demo/da-location' } } }, workspaceIdentifier: { uri: { path: '/x/y' } } } });
  assert.equal(fromLocation.name, 'da-location');
  assert.equal(fromLocation.key, 'local:path:/Users/demo/da-location');
  assert.equal(fromLocation.sectionId, sectionIdFor(fromLocation.key));

  const fromIdentifier = r.resolve({ workspaceId: 'ws-a', header: { workspaceIdentifier: { uri: { scheme: 'file', path: '/Users/demo/da-identifier' } } } });
  assert.equal(fromIdentifier.name, 'da-identifier');

  const fromStorage = r.resolve({ workspaceId: 'ws-a', header: { agentLocation: { type: 'local', environment: { id: 'e' } } } });
  assert.equal(fromStorage.name, 'da-storage');
  assert.equal(fromStorage.parent, 'demo');

  const multi = r.resolve({ workspaceId: 'ws-multi', header: {} });
  assert.equal(multi.name, 'mio');

  const home = r.resolve({ workspaceId: 'sconosciuto', header: { agentLocation: { type: 'local', environment: { id: 'empty-window' } } } });
  assert.deepEqual({ key: home.key, home: home.home, path: home.path }, { key: HOME_KEY, home: true, path: null });

  // a workspaceId with path characters is never used to read files
  const evil = r.resolve({ workspaceId: '../../etc', header: {} });
  assert.equal(evil.home, true);
});

const S = (id, label, lastUpdatedAt) => ({ id, label, lastUpdatedAt });

test('sidebar order: default = latest activity descending, tie-break by label', () => {
  const sections = [S('a', 'beta', 10), S('b', 'alfa', 10), S('c', 'gamma', 30)];
  assert.deepEqual(orderSections(sections, { sortGroupsBy: 'updated' }).map((s) => s.id), ['c', 'b', 'a']);
  assert.deepEqual(orderSections(sections, null).map((s) => s.id), ['c', 'b', 'a'], 'no settings: empty manual = default');
});

test('manual sidebar order: new sections (in default order) first, then saved order', () => {
  const sections = [S('a', 'a', 10), S('b', 'b', 20), S('c', 'c', 30), S('d', 'd', 5)];
  const settings = { sortGroupsBy: 'manual', sectionOrderByGroupBy: { workspace: ['a', 'zzz', 'd', 'a'] } };
  // not saved: b(20), c(30) -> default order c, b ; then saved present and deduped: a, d
  assert.deepEqual(orderSections(sections, settings, 'workspace').map((s) => s.id), ['c', 'b', 'a', 'd']);
  // other grouping: no saved order -> default
  assert.deepEqual(orderSections(sections, settings, 'repository').map((s) => s.id), ['c', 'b', 'a', 'd']);
});

test('sections collapsed in Cursor', () => {
  assert.deepEqual([...collapsedIds({ collapsedSectionIdsByGroupBy: { workspace: ['x', 'y'] } }, 'workspace')], ['x', 'y']);
  assert.equal(collapsedIds(null).size, 0);
  assert.equal(collapsedIds({ collapsedSectionIdsByGroupBy: { workspace: 'no' } }).size, 0);
});
