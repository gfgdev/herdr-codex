import test from 'node:test';
import assert from 'node:assert/strict';
import {parseManifest, allocate} from '../src/manifest.mjs';
test('parses the current simple export', () => assert.deepEqual(parseManifest('id,units,priority\nA,2,3\nB,4,1\n'), [{id:'A',units:2,priority:3},{id:'B',units:4,priority:1}]));
test('accepts the header-only export', () => assert.deepEqual(parseManifest('id,units,priority\n'), []));
test('preserves allocator priority and original tie order', () => assert.deepEqual(allocate([{id:'A',units:2,priority:1},{id:'B',units:3,priority:2},{id:'C',units:1,priority:1}],5),{selected:['B','A'],remaining:0}));
test('rejects invalid capacity', () => assert.throws(() => allocate([], -1), /capacity/));
