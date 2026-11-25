// Each receipt has its own storage key. Accepting one delivery does not rewrite
// other receipts, scan history, or the folder scan checkpoint.
const PREFIX = "incomingReceipt:";

export class IncomingQueue {
  constructor(storage) {
    this.storage = storage;
    this.entries = new Map();
    this.bySession = new Map();
    this.sequence = 0;
  }

  restore(stored) {
    const entries = [];
    for (const [key, entry] of Object.entries(stored)) {
      if (!key.startsWith(PREFIX)) continue;
      if (!entry || key !== PREFIX + entry.key || !entry.locator?.accountId ||
          !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isFinite(Date.parse(entry.createdAt))) {
        throw new Error("Invalid incoming mail receipt");
      }
      entries.push(entry);
    }
    entries.sort((a, b) => a.sequence - b.sequence);
    this.entries.clear();
    this.bySession.clear();
    for (const entry of entries) this.remember(entry);
  }

  remember(entry) {
    this.entries.set(entry.key, entry);
    this.sequence = Math.max(this.sequence, entry.sequence || 0);
    if (!entry.session) return;
    if (!this.bySession.has(entry.session)) this.bySession.set(entry.session, new Map());
    this.bySession.get(entry.session).set(entry.messageId, entry);
  }

  find(session, messageId) {
    return this.bySession.get(session)?.get(messageId);
  }

  async accept(entry) {
    entry = { ...entry, sequence: ++this.sequence };
    await this.storage.set({ [PREFIX + entry.key]: entry });
    this.remember(entry);
  }

  async adoptQueued(records) {
    // Legacy scanner slots remain the authoritative copies of past decisions.
    // Persist the missing receipts in bounded batches before processing resumes.
    let batch = [];
    const flush = async () => {
      await this.storage.set(Object.fromEntries(batch.map(entry => [PREFIX + entry.key, entry])));
      for (const entry of batch) this.remember(entry);
      batch = [];
    };
    for (const record of records) {
      if (!record || record.source !== "automatic" || !["queued", "scanning"].includes(record.status) ||
          record.bulkRetryId || !record.locator?.accountId || this.entries.has(record.key)) continue;
      batch.push({ key: record.key, createdAt: Number.isFinite(Date.parse(record.createdAt)) ?
        record.createdAt : new Date().toISOString(), locator: record.locator,
        sequence: ++this.sequence, messageId: record.messageId ?? null, session: record.session ?? null,
        ...(record.quarantineIntent ? {quarantineIntent: record.quarantineIntent} : {}),
        ...(record.quarantineCheckPending ? {quarantineCheckPending: true} : {}) });
      if (batch.length === 64) await flush();
    }
    if (batch.length) await flush();
  }

  async markAmbiguousReceipts(history) {
    // A deleted sibling can leave a single matching header after restart.
    // Preserve that prior ambiguity even after the other receipt is retired.
    const owners = new Map(), ambiguous = new Set();
    const identity = locator => JSON.stringify([locator.accountId, locator.headerMessageId,
      locator.author, locator.subject, locator.date]);
    for (const entry of this.entries.values()) {
      if (!entry.locator.headerMessageId) continue;
      const group = identity(entry.locator);
      if (owners.has(group)) ambiguous.add(group);
      else owners.set(group, entry);
    }
    for (const record of history) {
      if (!record?.session || !Number.isInteger(record.messageId) || !record.locator?.headerMessageId) continue;
      const group = identity(record.locator), entry = owners.get(group);
      if (entry && entry.session === record.session && entry.messageId !== record.messageId && entry.key !== record.key) {
        ambiguous.add(group);
      }
    }
    if (!ambiguous.size) return;
    let changes = {};
    for (const entry of this.entries.values()) {
      if (entry.ambiguousAfterRestart || !ambiguous.has(identity(entry.locator))) continue;
      const updated = { ...entry, ambiguousAfterRestart:true };
      changes[PREFIX + entry.key] = updated;
      this.remember(updated);
      if (Object.keys(changes).length === 64) {
        await this.storage.set(changes);
        changes = {};
      }
    }
    if (Object.keys(changes).length) await this.storage.set(changes);
  }

  removeIndex(entry) {
    if (!entry) return;
    const index = this.bySession.get(entry.session);
    if (index?.get(entry.messageId)?.key === entry.key) {
      index.delete(entry.messageId);
      if (!index.size) this.bySession.delete(entry.session);
    }
  }

  async relocate(entry, messageId, locator) {
    const updated = { ...entry, messageId, locator };
    await this.storage.set({ [PREFIX + entry.key]: updated });
    this.removeIndex(entry);
    this.remember(updated);
  }

  // Call only after a result or a durable handoff carrying this key is saved.
  async finish(key) {
    await this.storage.remove(PREFIX + key);
    this.removeIndex(this.entries.get(key));
    this.entries.delete(key);
  }
}
