const fixture = await messenger.testFixture.prepare();
for (const [kind, raw] of Object.entries(fixture.mails)) await messenger.messages.import(new File([raw], kind + ".eml", { type: "message/rfc822" }), fixture.source.id, { read: true, new: false });
await messenger.messages.import(new File([fixture.mails.plain.replace("Synthetic plain", "Synthetic legacy")], "legacy.eml", { type: "message/rfc822" }), fixture.history.id, { read: true, new: false });
const { locator, sha256 } = await import("../core.mjs");
const { reviewReason } = await import("../review.mjs");
const { messages: [message] } = await messenger.messages.list(fixture.history.id);
const raw = await messenger.messages.getRaw(message.id, { data_format: "File", decrypt: false });
const digest = await sha256(new Uint8Array(await raw.arrayBuffer()));
const record = { key: "preserved-review", status: "incomplete", detail: "Synthetic retained result", locator: locator(message),
  sha256: digest, signatures: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
record.review = { at: new Date().toISOString(), note: "Synthetic human decision", resultHash: digest, reason: reviewReason(record), fingerprint: "sha256:" + digest };
await messenger.storage.local.set({ records: [record], settings: { enabled: true, accountIds: [fixture.accountId], notifications: false,
  scanSettings: { phishing: "off", macros: "off", pua: "off", mailMiB: 25, expandedMiB: 100, seconds: 60 },
  quarantine: { [fixture.accountId]: { folderId: fixture.quarantine.id, path: fixture.quarantine.path, auto: false } } },
  installation: { state: "managed", healthy: true, version: "0.19.2" } });
await messenger.testFixture.update();
