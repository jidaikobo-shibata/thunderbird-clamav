import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolbarUpdates } from '../thunderbird/toolbar-updates.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const notice=(text='',dot=null)=>({text,dot,color:'#9d281b',title:'Synthetic '+text});
test('pending rendering is bounded and releases only the latest state for each property',async()=>{
 const calls=[],gates=[];const action={};
 for(const name of ['setIcon','setBadgeText','setBadgeBackgroundColor','setTitle'])action[name]=value=>{calls.push([name,value]);return new Promise(r=>gates.push(r));};
 const toolbar=toolbarUpdates(action);toolbar.update(notice('1'));await tick();
 for(let i=2;i<=1000;i++)toolbar.update(notice(String(i),'attention'));
 await tick();assert.equal(calls.length,4);
 gates.splice(0).forEach(r=>r());await tick();
 assert.equal(calls.length,7,'unchanged color is not redrawn');
 assert.deepEqual(calls.slice(4),[['setIcon',{path:'icon-attention.svg'}],['setBadgeText',{text:'1000'}],['setTitle',{title:'Synthetic 1000'}]]);
 gates.splice(0).forEach(r=>r());await tick();toolbar.update(notice('1000','attention'));await tick();assert.equal(calls.length,7);
});
test('synchronous and async display failures are contained and retry on a later update',async()=>{
 let fail=true;const errors=[],calls=[];const action={};
 for(const name of ['setIcon','setBadgeText','setBadgeBackgroundColor','setTitle'])action[name]=value=>{calls.push(name);if(fail){if(name==='setIcon')throw Error('sync');return Promise.reject(Error('async'));}return Promise.resolve();};
 const toolbar=toolbarUpdates(action,e=>{errors.push(e.message);throw Error('logger');});
 toolbar.update(notice());await tick();assert.equal(calls.length,4);assert.equal(errors.length,4);
 await tick();assert.equal(calls.length,4,'no recursive retry loop');
 fail=false;toolbar.update(notice());await tick();assert.equal(calls.length,8);
 toolbar.update(notice());await tick();assert.equal(calls.length,8);
});
test('a slow failed update cannot replace newer desired values',async()=>{
 let reject;const calls=[];let first=true;
 const action={setIcon:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{},setBadgeText:value=>{calls.push(value.text);if(first){first=false;return new Promise((_,r)=>{reject=r;});}return Promise.resolve();}};
 const toolbar=toolbarUpdates(action,()=>{});toolbar.update(notice('1'));await tick();toolbar.update(notice('2'));reject(Error('late'));await tick();assert.deepEqual(calls,['1','2']);
});
