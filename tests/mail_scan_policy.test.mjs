import assert from "node:assert/strict";
import { test } from "node:test";
import { scanPolicy, SCAN_DEFAULTS, defaultScanPolicy, advisoryNotifies } from "../thunderbird/scan-policy.mjs";
import { NativeClient, needsAttention } from "../thunderbird/core.mjs";
import { canQuarantine } from "../thunderbird/quarantine.mjs";
import { filterRecords, canRetry, canDelete } from "../thunderbird/results.mjs";
import { reviewReason, isReviewed } from "../thunderbird/review.mjs";

test("scan policy enforces numeric bounds, relationships and fixed mode names", () => {
  assert.deepEqual(scanPolicy(), SCAN_DEFAULTS);
  assert.equal(defaultScanPolicy(), true);
  assert.equal(defaultScanPolicy({ phishing: "display" }), false);
  for (const value of [null, [], { mailMiB: true }, { mailMiB: 101 }, { mailMiB: 4 }, { mailMiB: 5.5 }, { expandedMiB: 501 }, { expandedMiB: 24 }, { seconds: 9 }, { seconds: 121 }, { phishing: "yes; command" }, { pua: true }, { mailMiB: 50, expandedMiB: 25 }, { arbitraryOption: "yes" }]) assert.throws(() => scanPolicy(value));
  assert.equal(scanPolicy({ mailMiB: 100, expandedMiB: 500, seconds: 120 }).mailMiB, 100);
});

test("advisories remain reviewable attention results and never become quarantine candidates", () => {
  const r = { status: "advisory", detail: "finding", signatures: ["PUA.Example"], sha256: "body", locator: { accountId: "one" },
    advisories: [{ kind: "pua" }], scanSettings: scanPolicy({ pua: "display" }) };
  assert.equal(needsAttention(r), true);
  assert.equal(advisoryNotifies(r), false);
  assert.equal(canQuarantine(r), false);
  assert.equal(canRetry(r) && canDelete(r), true);
  assert.equal(filterRecords([r], { status: "advisory" }).length, 1);
  assert.equal(filterRecords([r], { search: "不要な可能性" }).length, 1);
  r.scanSettings.pua = "notify"; assert.equal(advisoryNotifies(r), true);
  r.review = { reason: reviewReason(r), resultHash: "body" }; assert.equal(isReviewed(r), true);
  assert.equal(needsAttention(r), false);
});

test("native settings acknowledgement is required and malformed results fail closed", async () => {
  const event = () => ({ addListener(fn) { this.fn = fn; } });
  const options = scanPolicy({ macros: "notify" });
  for (const acknowledged of [false, true]) {
    const port = { onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(request) {
      queueMicrotask(() => this.onMessage.fn({ id: request.id, ...(request.op === "end" ? { status: "advisory", sha256: "digest", ...(acknowledged ? { scanSettings: options } : {}) } : { status: "accepted", seq: request.seq + 1 }) }));
    } };
    const client = new NativeClient({ connectNative: () => port });
    if (acknowledged) assert.equal((await client.scan(new Uint8Array([1]), "digest", options)).status, "advisory");
    else await assert.rejects(client.scan(new Uint8Array([1]), "digest", options), /検査条件/);
    client.close();
  }
});

test("policy form errors identify fields and retain their entered values", async () => {
  const { readScanPolicy } = await import('../thunderbird/scan-policy.mjs');
  const previous = globalThis.document;
  const inputs = Object.fromEntries(Object.entries(SCAN_DEFAULTS).map(([key,value]) => ['scan-'+key,{value:String(value)}]));
  globalThis.document = {getElementById:id=>inputs[id]};
  try {
    for(const [key,value,expected] of [['mailMiB','4','mailMiB'],['mailMiB','5.5','mailMiB'],['seconds','','seconds'],['phishing','unknown','phishing']]) {
      inputs['scan-'+key].value=value;
      assert.throws(readScanPolicy,error=>error.fields[0].key===expected&&error.fields[0].message.length>0);
      assert.equal(inputs['scan-'+key].value,value);
      inputs['scan-'+key].value=String(SCAN_DEFAULTS[key]);
    }
    inputs['scan-mailMiB'].value='100';inputs['scan-expandedMiB'].value='25';
    assert.throws(readScanPolicy,error=>error.fields[0].key==='expandedMiB'&&error.message.includes('100'));
    inputs['scan-expandedMiB'].value='100';
    assert.equal(readScanPolicy().mailMiB,100);
  } finally { if(previous===undefined)delete globalThis.document;else globalThis.document=previous; }
});
