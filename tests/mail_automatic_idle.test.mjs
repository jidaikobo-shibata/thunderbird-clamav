import assert from "node:assert/strict";
import { test } from "node:test";
import { AutomaticIdle, AUTOMATIC_IDLE_SECONDS } from "../thunderbird/automatic-idle.mjs";

function fixture(query = async () => "active") {
  let listener, wakes = 0, queries = 0;
  const gate = new AutomaticIdle({
    onStateChanged: { addListener(callback) { listener = callback; } },
    setDetectionInterval(seconds) { assert.equal(seconds, AUTOMATIC_IDLE_SECONDS); },
    queryState(seconds) { assert.equal(seconds, 30); queries++; return query(); }
  }, () => { wakes++; });
  return {gate, change: state => listener(state), wakes: () => wakes, queries: () => queries};
}
test("disabled default does not query idle state or block scanning", async () => {
  const f = fixture(); await f.gate.refresh(false); f.change("idle");
  assert(f.gate.canStart({})); assert.equal(f.queries(), 0); assert.equal(f.wakes(), 0);
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
});
test("active input pauses subsequent starts and idle wakes pending work", async () => {
  const f = fixture(); await f.gate.refresh(true);
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
  f.change("idle"); assert(f.gate.canStart({idleAutomatic:true}));
  f.change("active"); assert.equal(f.gate.canStart({idleAutomatic:true}), false);
  assert.equal(f.wakes(), 1);
});
test("a late query cannot override a newer active event", async () => {
  let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.gate.refresh(true); await new Promise(resolve => setImmediate(resolve));
  f.change("active"); release("idle"); await pending;
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
});
test("queries coalesce and failures leave automatic work waiting", async () => {
  const f = fixture(async () => { throw Error("unsupported idle backend"); });
  const pending = f.gate.refresh(true); assert.equal(f.gate.refresh(true), pending);
  await assert.rejects(pending, /unsupported/);
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
  await f.gate.refresh(false); assert(f.gate.canStart({}));
});
test("a disabled setting invalidates outstanding idle responses", async () => {
  let release; const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.gate.refresh(true); await new Promise(resolve => setImmediate(resolve));
  await f.gate.refresh(false); release("idle"); await pending;
  assert.equal(f.wakes(), 0);
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
});
test("a stalled backend expires and its late response cannot start inspection", async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(f.gate.refresh(true), /timed out/);
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
  await f.gate.refresh(true);
  assert.equal(f.queries(), 1, "timed-out native queries are not replaced while still outstanding");
  release("idle"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.gate.canStart({idleAutomatic:true}), false);
});

test("compose gates body reads while reading and stable background wake the queue", async () => {
  let focus, activity, resolveReading, wakes = 0;
  const windows = {
    WINDOW_ID_NONE: -1,
    onFocusChanged: { addListener(fn) { focus = fn; } },
    getLastFocused: async () => ({focused:true,type:"messageCompose"}),
    get: async id => id === 3 ? new Promise(resolve => { resolveReading = resolve; }) :
      {focused:true,type:id === 1 ? "messageCompose" : "normal"}
  };
  const gate = new AutomaticIdle({
    onStateChanged:{addListener(fn) { activity = fn; }},
    setDetectionInterval() {}, queryState:async () => "active"
  }, () => { wakes++; }, windows);
  const settings = {idleAutomatic:true};
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await gate.refresh(true); await tick();
  assert.equal(gate.waitingState, "compose");
  assert.equal(gate.canStart(settings), false);
  activity("idle"); assert.equal(gate.canStart(settings), true);
  activity("active"); assert.equal(gate.canStart(settings), false);
  focus(2); await tick(); assert.equal(gate.canStart(settings), true);
  focus(-1); assert.equal(gate.canStart(settings), false);
  focus(3); focus(1); resolveReading({focused:true,type:"normal"}); await tick();
  assert.equal(gate.canStart(settings), false);
  const before = wakes;
  focus(-1); await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(gate.canStart(settings), true); assert.ok(wakes > before);
  focus(1); assert.equal(gate.canStart(settings), false);
  await tick(); assert.equal(gate.canStart(settings), false);
  focus(-1); await gate.refresh(false); await gate.refresh(true); await tick();
  assert.equal(gate.canStart(settings), false);
});
