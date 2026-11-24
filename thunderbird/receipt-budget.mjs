// Bound all retained pages, including active notifications waiting on list IO.
export class ReceiptBudget {
  constructor({ maxReceipts = 128, maxMessages = 256, maxCharacters = 4 * 1024 * 1024 } = {}) {
    Object.assign(this, { maxReceipts, maxMessages, maxCharacters });
    this.receipts = new Map();
    this.characters = 0;
  }
  page(receipt, page) {
    const previous = this.receipts.get(receipt) || 0;
    if (!this.receipts.has(receipt) && this.receipts.size >= this.maxReceipts) return false;
    if (!Array.isArray(page?.messages) || page.messages.length > this.maxMessages) return false;
    const size = JSON.stringify(page).length;
    if (this.characters - previous + size > this.maxCharacters) return false;
    this.receipts.set(receipt, size);
    this.characters += size - previous;
    return true;
  }
  releasePage(receipt) {
    if (!this.receipts.has(receipt)) return;
    this.characters -= this.receipts.get(receipt);
    this.receipts.set(receipt, 0);
  }
  delete(receipt) {
    this.releasePage(receipt);
    this.receipts.delete(receipt);
  }
}
