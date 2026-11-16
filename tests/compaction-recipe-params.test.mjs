/**
 * Focused regression for the REAL compaction recipe's parameter path (correction #4).
 *
 * The bounded adapter forwards `previous_summary_json` on every attempt; before this
 * regression the recipe declared neither the parameter nor an interpolation, so the native
 * renderer silently dropped the prior accepted summary and the model could not consume it.
 *
 * This test does two things:
 *   1. Static: the authored recipe declares `previous_summary_json` and interpolates
 *      `{{previous_summary_json}}` inside the prompt (so the native renderer has somewhere
 *      to substitute it).
 *   2. Native (opt-in, macOS + HERDR_TEST_GOOSE): renders the ACTUAL recipe with the real
 *      Goose binary and asserts the prior-summary value survives interpolation. No model
 *      inference is performed (`--render-recipe` only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {load,JSON_SCHEMA} from '../src/vendor-js-yaml.mjs';

const packageRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const recipePath=join(packageRoot,'recipes','compaction','recipe.yaml');
const recipe=load(readFileSync(recipePath,'utf8'),{schema:JSON_SCHEMA});

test('compaction recipe declares previous_summary_json and interpolates it in the prompt',()=>{
 const param=(recipe.parameters||[]).find(p=>p.key==='previous_summary_json');
 assert.ok(param,'recipe must declare a previous_summary_json parameter');
 assert.equal(param.requirement,'optional');
 assert.equal(param.input_type,'string');
 assert.equal(param.default,'null');
 assert.match(String(param.description),/CANONICAL SINGLE-LINE JSON/);
 assert.match(String(recipe.prompt),/\{\{\s*previous_summary_json\s*\}\}/,'prompt must interpolate {{previous_summary_json}}');
 // The prior summary is prior ACCEPTED state, not instruction text.
 assert.match(String(recipe.instructions),/PRIOR ACCEPTED SUMMARY/);
});

test('compaction recipe keeps the adapter-owned passthrough schema unchanged',()=>{
 const schema=recipe.response.json_schema;
 const passthrough=schema.definitions.passthrough;
 assert.deepEqual([...passthrough.required].sort(),['first_kept_entry_id','input_digest','session_identity','tokens_before']);
 assert.equal(passthrough.additionalProperties,false);
 // previous_summary_json is an INPUT, not an echoed adapter-owned output field.
 assert.equal(Object.prototype.hasOwnProperty.call(passthrough.properties,'previous_summary_json'),false);
});

test('native Goose renders the real recipe and interpolates the prior summary',{
 skip:process.platform!=='darwin'||!process.env.HERDR_TEST_GOOSE?'Requires explicit macOS native Goose rendering test':false,
},()=>{
 const goose=process.env.HERDR_TEST_GOOSE;
 assert.ok(goose,'HERDR_TEST_GOOSE must point at the goose binary');
 const scratch=mkdtempSync(join(tmpdir(),'herdr-compaction-render-'));
 try{
  for(const d of ['cfg','data','state','cache']) mkdirSync(join(scratch,d),{recursive:true});
  const env={...process.env,XDG_CONFIG_HOME:join(scratch,'cfg'),XDG_DATA_HOME:join(scratch,'data'),XDG_STATE_HOME:join(scratch,'state'),XDG_CACHE_HOME:join(scratch,'cache')};
  const run=extra=>spawnSync(goose,['run','--recipe',recipePath,'--params','history_json={"a":1}',...extra,'--render-recipe','--quiet'],{encoding:'utf8',env,timeout:60000});
  const plain=run([]);
  assert.equal(plain.status,0,plain.stderr);
  const withPrior=run(['--params','previous_summary_json={"keep15tools":true}']);
  assert.equal(withPrior.status,0,withPrior.stderr);
  assert.ok(withPrior.stdout.includes('keep15tools'),'prior-summary value must survive native interpolation');
  const validate=spawnSync(goose,['recipe','validate',recipePath],{encoding:'utf8',env,timeout:60000});
  assert.equal(validate.status,0,validate.stderr);
 }finally{
  rmSync(scratch,{recursive:true,force:true});
 }
});
