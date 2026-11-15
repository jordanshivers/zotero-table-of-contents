const { test } = require('node:test');
const assert = require('node:assert/strict');
global.PDFLib = require('../src/vendor/pdf-lib.min.js');
const O = require('../src/outline.js');
const { PDFDocument, PDFName: N, PDFHexString: S, PDFNumber } = PDFLib;
async function fixture() {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage().drawText(`Chapter ${i + 1}`, { x: 60, y: 700 });
  return pdf;
}
async function roundtrip(pdf) { return PDFDocument.load(await pdf.save(), { updateMetadata: false }); }
const add = (pdf, title, pageIndex, extra = {}) => O.edit(pdf, { type: 'add', title, pageIndex, ...extra });
// "A(B,C) D" style summary of the outline.
const show = items => items.map(i => i.title + (i.children.length ? `(${show(i.children)})` : '')).join(' ');
// Raw link consistency check.
function checkLinks(pdf) {
  const get = (node, name) => node.get(N.of(name));
  const visit = (ref) => {
    const node = pdf.context.lookup(ref);
    let visible = 0, previous, child = get(node, 'First');
    if (!child) assert.equal(get(node, 'Last'), undefined);
    while (child) {
      const c = pdf.context.lookup(child);
      assert.equal(get(c, 'Parent').toString(), ref.toString());
      assert.equal(get(c, 'Prev')?.toString(), previous?.toString());
      visible += 1 + visit(child);
      previous = child; child = get(c, 'Next');
    }
    if (previous) assert.equal(get(node, 'Last').toString(), previous.toString());
    const count = node.lookup(N.of('Count'));
    if (ref === rootRef || visible) assert.equal(Math.abs(count.asNumber()), visible);
    else assert.equal(count, undefined);
    return count && count.asNumber() > 0 ? visible : 0;
  };
  const rootRef = pdf.catalog.get(N.of('Outlines'));
  visit(rootRef);
}
test('add, sort, Unicode, rename, delete, reopen; page content survives', async () => {
  let pdf = await fixture();
  add(pdf, 'Chapter 3', 2);
  assert.deepEqual(add(pdf, 'Châpitre 一 🧪', 0), { path: [0], title: 'Châpitre 一 🧪', total: 2 });
  pdf = await roundtrip(pdf);
  assert.deepEqual(O.tree(pdf).map(e => [e.title, e.pageIndex]), [['Châpitre 一 🧪', 0], ['Chapter 3', 2]]);
  O.edit(pdf, { type: 'rename', path: [0], title: ' Opening ' });
  assert.deepEqual(O.edit(pdf, { type: 'remove', path: [1] }), { path: null, title: null, total: 1 });
  pdf = await roundtrip(pdf);
  assert.deepEqual(O.tree(pdf), [{ title: 'Opening', pageIndex: 0, children: [] }]);
  O.edit(pdf, { type: 'retarget', path: [0], pageIndex: 3 });
  assert.equal(O.tree(await roundtrip(pdf))[0].pageIndex, 3);
  O.edit(pdf, { type: 'remove', path: [0] });
  pdf = await roundtrip(pdf);
  assert.deepEqual(O.tree(pdf), []);
  checkLinks(pdf);
  assert.equal(pdf.getPageCount(), 4);
  assert.ok(pdf.getPage(0).node.Contents());
});
test('nests, moves, and deletes entries with consistent links and counts', async () => {
  let pdf = await fixture();
  add(pdf, 'A', 0); add(pdf, 'B', 1); add(pdf, 'C', 2); add(pdf, 'D', 3);
  assert.deepEqual(O.edit(pdf, { type: 'move', path: [1], direction: 'indent' }).path, [0, 0]);
  assert.deepEqual(O.edit(pdf, { type: 'move', path: [1], direction: 'indent' }).path, [0, 1]);
  assert.equal(show(O.tree(pdf)), 'A(B C) D'); checkLinks(pdf);
  // 'child' sorts by page; 'after' places exactly.
  assert.deepEqual(add(pdf, 'B2', 1, { where: 'child', path: [0] }).path, [0, 1]);
  assert.deepEqual(add(pdf, 'C1', 2, { where: 'child', path: [0, 2] }).path, [0, 2, 0]);
  assert.deepEqual(add(pdf, 'E', 0, { where: 'after', path: [1] }).path, [2]);
  pdf = await roundtrip(pdf);
  assert.equal(show(O.tree(pdf)), 'A(B B2 C(C1)) D E'); checkLinks(pdf);
  assert.equal(pdf.catalog.lookup(N.of('Outlines')).lookup(N.of('Count')).asNumber(), 7);
  O.edit(pdf, { type: 'move', path: [0, 2], direction: 'up' });
  O.edit(pdf, { type: 'move', path: [0, 0], direction: 'down' });
  assert.equal(show(O.tree(pdf)), 'A(C(C1) B B2) D E'); checkLinks(pdf);
  // Moving out keeps children.
  assert.deepEqual(O.edit(pdf, { type: 'move', path: [0, 0], direction: 'outdent' }).path, [1]);
  pdf = await roundtrip(pdf);
  assert.equal(show(O.tree(pdf)), 'A(B B2) C(C1) D E'); checkLinks(pdf);
  assert.throws(() => O.edit(pdf, { type: 'move', path: [0], direction: 'up' }), /already first/);
  assert.throws(() => O.edit(pdf, { type: 'move', path: [3], direction: 'down' }), /already last/);
  assert.throws(() => O.edit(pdf, { type: 'move', path: [0], direction: 'indent' }), /no entry above/);
  assert.throws(() => O.edit(pdf, { type: 'move', path: [0], direction: 'outdent' }), /top level/);
  // Delete removes sub-entries.
  assert.equal(O.edit(pdf, { type: 'remove', path: [0] }).total, 4);
  O.edit(pdf, { type: 'remove', path: [0, 0] });
  pdf = await roundtrip(pdf);
  assert.equal(show(O.tree(pdf)), 'C D E'); checkLinks(pdf);
});
test('preserves pre-existing hierarchical bookmarks, collapsed state, and named destinations', async () => {
  let pdf = await fixture();
  const root = pdf.context.obj({ Type: 'Outlines', Count: 1 });
  const rootRef = pdf.context.register(root);
  const parent = pdf.context.obj({ Title: S.fromText('Original'), Parent: rootRef, Dest: S.fromText('named-target'), Count: -1 });
  const parentRef = pdf.context.register(parent);
  const child = pdf.context.obj({ Title: S.fromText('Nested'), Parent: parentRef, Dest: [pdf.getPage(1).ref, 'Fit'] });
  const childRef = pdf.context.register(child);
  parent.set(N.of('First'), childRef); parent.set(N.of('Last'), childRef);
  root.set(N.of('First'), parentRef); root.set(N.of('Last'), parentRef);
  pdf.catalog.set(N.of('Outlines'), rootRef);
  pdf.catalog.set(N.of('Dests'), pdf.context.obj({ 'named-target': [pdf.getPage(0).ref, 'Fit'] }));
  assert.deepEqual(add(pdf, 'New', 3).path, [1]);
  // Collapsed stays collapsed.
  add(pdf, 'Inner', 2, { where: 'child', path: [0] });
  assert.equal(parent.lookup(N.of('Count')).asNumber(), -2);
  assert.equal(root.lookup(N.of('Count')).asNumber(), 2);
  O.edit(pdf, { type: 'remove', path: [0, 1] });
  O.edit(pdf, { type: 'remove', path: [1] });
  pdf = await roundtrip(pdf);
  const restored = pdf.context.lookup(parentRef);
  assert.equal(restored.lookup(N.of('Title')).decodeText(), 'Original');
  assert.equal(restored.lookup(N.of('Dest')).decodeText(), 'named-target');
  assert.equal(restored.get(N.of('First')).toString(), childRef.toString());
  assert.equal(restored.lookup(N.of('Count')).asNumber(), -1);
  assert.equal(pdf.context.lookup(rootRef).lookup(N.of('Count')).asNumber(), 1);
  assert.ok(pdf.catalog.get(N.of('Dests')));
  checkLinks(pdf);
});
test('follows the sidebar: hidden lone top entry, stale lists, detected headings', async () => {
  const pdf = await fixture();
  // Nothing saved in the PDF yet.
  assert.throws(() => O.edit(pdf, { type: 'rename', path: [0], title: 'X' }), /detected these headings/);
  add(pdf, 'Book', 0);
  add(pdf, 'One', 1, { where: 'child', path: [0] });
  add(pdf, 'Two', 2, { where: 'child', path: [0] });
  // Sidebar paths skip the hidden "Book".
  assert.deepEqual(O.sidebarPath(O.tree(pdf), [0, 1]), [1]);
  assert.equal(O.sidebarPath(O.tree(pdf), [0]), null);
  assert.deepEqual(O.edit(pdf, { type: 'rename', path: [1], shape: [2], title: 'Second' }).path, [0, 1]);
  assert.throws(() => O.edit(pdf, { type: 'rename', path: [1], shape: [3], title: 'X' }), /out of date/);
  assert.throws(() => O.edit(pdf, { type: 'remove', path: [5] }), /out of date/);
  assert.throws(() => O.edit(pdf, { type: 'remove', path: [] }), /out of date/);
  assert.deepEqual(O.edit(pdf, { type: 'move', path: [0], direction: 'outdent' }).path, [1]);
  assert.equal(show(O.tree(pdf)), 'Book(Second) One');
  assert.deepEqual(O.sidebarPath(O.tree(pdf), [0, 0]), [0, 0]);
});
test('refuses invalid pages, blank titles, signatures, and cyclic outlines', async () => {
  const pdf = await fixture();
  for (const pageIndex of [-1, 4, 1.5]) assert.throws(() => add(pdf, 'X', pageIndex));
  assert.throws(() => add(pdf, ' ', 0));
  add(pdf, 'X', 0);
  assert.throws(() => O.edit(pdf, { type: 'retarget', path: [0], pageIndex: 9 }), /unavailable/);
  assert.throws(() => O.edit(pdf, { type: 'rename', path: [0], title: '' }), /title/);
  assert.throws(() => O.edit(pdf, { type: 'explode', path: [0] }), /Unknown/);
  pdf.context.register(pdf.context.obj({ FT: 'Sig' }));
  assert.throws(() => add(pdf, 'X', 0), /signed/);
  const cyclic = await fixture();
  add(cyclic, 'X', 0);
  const root = cyclic.catalog.lookup(N.of('Outlines'));
  const ref = root.get(N.of('First'));
  cyclic.context.lookup(ref).set(N.of('Next'), ref);
  assert.throws(() => O.tree(cyclic), /Circular/);
});
