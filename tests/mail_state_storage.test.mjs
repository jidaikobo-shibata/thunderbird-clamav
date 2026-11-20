import assert from "node:assert/strict";
import { test } from "node:test";
import { StateStorage, CheckpointMap, readStoredState } from "../thunderbird/state-storage.mjs";

function fixture() {
  let raw = {}, fail = false;
  const writes = [];
  const store = new StateStorage({ set: async patch => {
    if (fail) throw new Error("synthetic disk full");
    writes.push(structuredClone(patch)); raw = { ...raw, ...structuredClone(patch) };
  } });
  const checkpoints = new CheckpointMap();
  const records = Array.from({ length: 1000 }, (_, index) => ({ key: "history-" + index, status: "clean", review: { note: "synthetic " + index } }));
  const snapshot = () => store.snapshot({ folderJob: { id: "job" } }, records, checkpoints.snapshot("job"));
  return { store, records, checkpoints, writes, snapshot, raw: () => structuredClone(raw), fail: value => { fail = value; } };
}

test("one changed result writes only its history shard and restores ordering and notes", async () => {
  const h = fixture();
  await h.store.write(h.snapshot(), { enabled: true });
  h.records[537].status = "detected";
  await h.store.write(h.snapshot(), { enabled: false });
  const patch = h.writes.at(-1);
  assert.equal(Object.keys(patch).filter(key => key.startsWith("historyPage:")).length, 1);
  assert.equal(Object.hasOwn(patch, "records"), false);
  assert.deepEqual(readStoredState(h.raw()).records, h.records);
  assert.equal(h.raw().settings.enabled, false);
});

test("checkpoint growth rewrites only one bounded page instead of the whole map", async () => {
  const h = fixture();
  for (let index = 0; index < 30000; index++) h.checkpoints.set(index.toString().padStart(129, "0"), 1);
  await h.store.write(h.snapshot(), {});
  h.checkpoints.set("new-checkpoint", 1);
  await h.store.write(h.snapshot(), {});
  const patch = h.writes.at(-1);
  const keys = Object.keys(patch).filter(key => key.startsWith("checkpointPage:"));
  assert.equal(keys.length, 1);
  assert.ok(patch[keys[0]].length <= 256);
  assert.ok(JSON.stringify(patch).length < 40000);
  assert.deepEqual(readStoredState(h.raw()).folderCheckpoint.entries, [...h.checkpoints]);
});

test("queued snapshots are immutable and failure does not acknowledge unpersisted changes", async () => {
  const h = fixture();
  h.checkpoints.set("first", 1);
  const first = h.snapshot();
  h.records[0].review.note = "later decision";
  h.checkpoints.set("first", 2);
  h.checkpoints.set("second", 1);
  const second = h.snapshot();
  await h.store.write(first, {});
  assert.equal(readStoredState(h.raw()).records[0].review.note, "synthetic 0");
  assert.deepEqual(readStoredState(h.raw()).folderCheckpoint.entries, [["first", 1]]);
  h.fail(true);
  await assert.rejects(h.store.write(second, {}));
  assert.deepEqual(readStoredState(h.raw()).folderCheckpoint.entries, [["first", 1]]);
  h.fail(false);
  await h.store.write(second, {});
  assert.equal(readStoredState(h.raw()).records[0].review.note, "later decision");
  assert.deepEqual(readStoredState(h.raw()).folderCheckpoint.entries, [["first", 2], ["second", 1]]);
});

test("history removal and checkpoint reset clear old page data in the same commit", async () => {
  const h = fixture();
  for (let index = 0; index < 300; index++) h.checkpoints.set("key" + index, 1);
  await h.store.write(h.snapshot(), {});
  h.records.splice(0, 999);
  h.checkpoints.clear();
  await h.store.write(h.snapshot(), {});
  assert.equal(h.raw()["checkpointPage:0"], null);
  assert.equal(h.raw()["checkpointPage:1"], null);
  assert.deepEqual(readStoredState(h.raw()).records, h.records);
  assert.deepEqual(readStoredState(h.raw()).folderCheckpoint.entries, []);
});

test("legacy data remains readable and missing incremental pages fail closed", async () => {
  const legacy = { records: [{ key: "legacy", review: { note: "keep" } }], folderCheckpoint: { version: 1, id: "job", entries: [] } };
  assert.deepEqual(readStoredState(legacy), legacy);
  const h = fixture();
  await h.store.write(h.snapshot(), {});
  const missing = h.raw(); delete missing["historyPage:0"];
  assert.throws(() => readStoredState(missing), /Missing history/);
  h.checkpoints.set("key", 1);
  await h.store.write(h.snapshot(), {});
  const lost = h.raw(); delete lost["checkpointPage:0"];
  assert.throws(() => readStoredState(lost), /Missing checkpoint/);
});

test("checkpoint deletion keeps page indexes valid without mutating prior snapshots", () => {
  const map = new CheckpointMap(); map.set("a", 1).set("b", 2);
  const before = map.snapshot("job");
  map.delete("a");
  assert.deepEqual(before.pages, [[["a", 1], ["b", 2]]]);
  assert.deepEqual(map.snapshot("job").pages, [[["b", 2]]]);
});


test("unknown formats, invalid types, missing indexes and duplicate history keys are rejected",async()=>{
  for(const records of [{format:99},{format:"2"},{},true,0,""]){
    assert.throws(()=>readStoredState({records}),/Unsupported history/);
  }
  for(const folderCheckpoint of [{version:99,id:"job"},{version:"2",id:"job"},[],42,{version:1,id:"job",entries:null},{version:1,entries:[]}]){
    assert.throws(()=>readStoredState({folderCheckpoint}),/checkpoint/);
  }
  assert.throws(()=>readStoredState({"historyPage:0":[]}),/Missing history/);
  assert.throws(()=>readStoredState({records:[],"historyPage:0":[]}),/Missing history/);
  assert.throws(()=>readStoredState({folderCheckpoint:{version:1,id:"job",entries:[]},"checkpointPage:0":[]}),/Missing checkpoint/);
  assert.throws(()=>readStoredState({folderCheckpoint:null,"checkpointPage:0":[]}),/Missing checkpoint/);
  assert.deepEqual(readStoredState({}),{});
  assert.deepEqual(readStoredState({records:null,folderCheckpoint:null}),{records:null,folderCheckpoint:null});
  const h=fixture();await h.store.write(h.snapshot(),{});
  const raw=h.raw();raw.records.keys.push(raw.records.keys[0]);
  assert.throws(()=>readStoredState(raw),/Invalid history/);
});
