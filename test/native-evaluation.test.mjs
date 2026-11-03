import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {previousReservation,main} from '../scripts/evaluation/evaluate-native-collaboration.mjs';

test('native evaluation carries prior reservation and every retained native attempt without resetting the 50 CNY total',()=>{
 const root=mkdtempSync(join(tmpdir(),'apix-native-budget-'));
 for(const [name,value] of [['native-first',.25],['native-failed',.5],['other-suite',30]]){mkdirSync(join(root,name));writeFileSync(join(root,name,'budget.json'),JSON.stringify({reservedCny:value}));}
 const result=previousReservation(root);assert.equal(result.baselineReservedCny,1.972464);assert.equal(result.later.length,2);assert.equal(result.reservedCny,2.722464);
});

test('native inference cannot start without explicit worker billing confirmation',{timeout:40000},async()=>{
 await assert.rejects(()=>main(['--approve-cost']),/confirmation.*included/);
});
