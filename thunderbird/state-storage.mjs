// Fixed history shards and append-friendly checkpoint pages bound each write.
const HISTORY_SHARDS = 32;
export const CHECKPOINT_PAGE_SIZE = 256;
const historyKey = index => `historyPage:${index}`;
const checkpointKey = index => `checkpointPage:${index}`;
const copy = value => JSON.parse(JSON.stringify(value));

export class CheckpointMap extends Map {
  constructor() { super(); this.pages = []; this.positions = new Map(); }
  set(key, value) {
    if (this.has(key) && this.get(key) === value) return this;
    const position = this.positions.get(key) ?? this.size;
    const page = Math.floor(position / CHECKPOINT_PAGE_SIZE);
    const entries = [...(this.pages[page] || [])];
    entries[position % CHECKPOINT_PAGE_SIZE] = [key, value];
    this.pages[page] = entries;
    this.positions.set(key, position);
    return super.set(key, value);
  }
  clear() { super.clear(); this.pages = []; this.positions = new Map(); }
  delete(key) {
    if (!super.delete(key)) return false;
    const entries = [...this];
    this.clear();
    for (const [name, value] of entries) this.set(name, value);
    return true;
  }
  snapshot(id) {
    return { state: id ? { version: 2, id, count: this.size, pages: this.pages.length } : null,
      pages: id ? [...this.pages] : [] };
  }
}

/** Read both the original arrays and the incremental representation. */
export function readStoredState(raw) {
  const data = { ...raw };
  if (raw.records?.format === 2) {
    if (raw.records.shards !== HISTORY_SHARDS || !Array.isArray(raw.records.keys)) throw new Error("Invalid history storage index");
    data.records = [];
    for (let index = 0; index < HISTORY_SHARDS; index++) {
      const page = raw[historyKey(index)];
      if (!Array.isArray(page)) throw new Error("Missing history storage page");
      data.records.push(...page);
    }
    const order = new Map(raw.records.keys.map((key, index) => [key, index]));
    if (order.size !== data.records.length || new Set(data.records.map(record => record.key)).size !== order.size ||
        data.records.some(record => !order.has(record.key))) throw new Error("Invalid history storage order");
    data.records.sort((a, b) => order.get(a.key) - order.get(b.key));
  }
  if (raw.folderCheckpoint?.version === 2) {
    const state = raw.folderCheckpoint;
    if (!Number.isSafeInteger(state.count) || state.count < 0 || state.count > 100000 ||
        state.pages !== Math.ceil(state.count / CHECKPOINT_PAGE_SIZE)) throw new Error("Invalid checkpoint storage index");
    const entries = [];
    for (let index = 0; index < state.pages; index++) {
      const page = raw[checkpointKey(index)];
      if (!Array.isArray(page) || page.length !== Math.min(CHECKPOINT_PAGE_SIZE, state.count - entries.length)) throw new Error("Missing checkpoint storage page");
      entries.push(...page);
    }
    data.folderCheckpoint = { version: 1, id: state.id, entries };
  }
  return data;
}

export class StateStorage {
  constructor(storage) {
    this.storage = storage;
    this.history = [];
    this.committed = new Map();
    this.checkpointPages = 0;
  }
  restore(raw) {
    this.history = [];
    this.committed.clear();
    this.checkpointPages = Object.keys(raw).filter(key => /^checkpointPage:\d+$/.test(key)).length;
  }
  snapshot(fields, records, checkpoint) {
    const groups = Array.from({ length: HISTORY_SHARDS }, () => []);
    for (const record of records) {
      let hash = 0;
      for (const letter of record.key) hash = (Math.imul(hash, 31) + letter.charCodeAt(0)) >>> 0;
      groups[hash % HISTORY_SHARDS].push(record);
    }
    const history = groups.map((group, index) => {
      const text = JSON.stringify(group);
      if (this.history[index]?.text !== text) this.history[index] = { text, value: JSON.parse(text) };
      return this.history[index];
    });
    return { fields: copy({ ...fields, records: { format: 2, shards: HISTORY_SHARDS, keys: records.map(record => record.key) },
      folderCheckpoint: checkpoint.state }), history, checkpoints: checkpoint.pages };
  }
  async write(snapshot, settings) {
    const patch = { settings: structuredClone(settings) }, next = new Map();
    for (const [key, value] of Object.entries(snapshot.fields)) {
      if (key === "settings") continue;
      const text = JSON.stringify(value);
      next.set(key, text);
      if (this.committed.get(key) !== text) patch[key] = value;
    }
    snapshot.history.forEach((page, index) => {
      const key = historyKey(index);
      next.set(key, page.text);
      if (this.committed.get(key) !== page.text) patch[key] = page.value;
    });
    snapshot.checkpoints.forEach((page, index) => {
      const key = checkpointKey(index);
      next.set(key, page);
      if (this.committed.get(key) !== page) patch[key] = page;
    });
    for (let index = snapshot.checkpoints.length; index < this.checkpointPages; index++) patch[checkpointKey(index)] = null;
    // One atomic storage operation publishes pages and their indexes together.
    // Failed writes leave the committed baseline intact for the next attempt.
    await this.storage.set(patch);
    this.committed = next;
    this.checkpointPages = snapshot.checkpoints.length;
  }
}
