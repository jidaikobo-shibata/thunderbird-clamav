import assert from "node:assert/strict";
import { test } from "node:test";
import { ReceiptBudget } from "../thunderbird/receipt-budget.mjs";

test("active and failed receipts share one bounded page budget", () => {
  const budget = new ReceiptBudget({ maxReceipts: 2, maxMessages: 2, maxCharacters: 100 });
  const a = {}, b = {}, c = {};
  assert(budget.page(a, { messages: [1] }));
  assert(budget.page(b, { messages: [2] }));
  assert.equal(budget.page(c, { messages: [] }), false);
  budget.releasePage(a);
  assert.equal(budget.page(c, { messages: [] }), false, "waiting continuations retain a slot");
  assert.equal(budget.page(a, { messages: [1, 2, 3] }), false);
  assert.equal(budget.page(a, { messages: ["x".repeat(100)] }), false);
  budget.delete(a);
  assert(budget.page(c, { messages: [] }));
  budget.delete(b); budget.delete(c);
  assert.equal(budget.characters, 0);
  assert.equal(budget.receipts.size, 0);
});
test("replacing a page releases its previous character reservation", () => {
  const budget = new ReceiptBudget({ maxCharacters: 60 });
  const a = {};
  for (let i = 0; i < 100; i++) assert(budget.page(a, { messages: ["x".repeat(20)] }));
  assert(budget.characters < 60);
});
