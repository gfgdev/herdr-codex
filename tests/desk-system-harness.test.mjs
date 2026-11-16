import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fixtureRoot,verifyCoding} from '../scripts/test-desk-system-native.mjs';
test('independent coding acceptance rejects the unfixed parser, not a broken verifier program',async()=>{
 await assert.rejects(verifyCoding(join(fixtureRoot,'coding')),error=>{
  assert.equal(error.name,'AssertionError');assert.equal(error.code,'ERR_ASSERTION');
  assert.doesNotMatch(error.message,/SyntaxError/);
  assert.match(error.message,/Expected id,units,priority header|AssertionError/);
  assert.match(error.message,/parseManifest/);
  return true;
 });
});
