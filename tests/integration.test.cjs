// Bootstrap against real files and mocked Zotero APIs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFS = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const PDFLib = require('../src/vendor/pdf-lib.min.js');
global.PDFLib = PDFLib;
const Outline = require('../src/outline.js');
test('bootstrap: current page, disk save, backups, permissions, sidebar edits, cleanup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toc-integration-'));
  const file = path.join(dir, 'book.pdf');
  const pdf = await PDFLib.PDFDocument.create(); pdf.addPage(); pdf.addPage(); pdf.addPage();
  const original = await pdf.save(); await fs.writeFile(file, original);
  const calls = [];
  const inner = {
    _state: { outline: [{ title: 'Stale cached outline' }], sidebarView: 'outline', outlineQuery: 'old filter' },
    _lastView: { _iframeWindow: { PDFViewerApplication: { pdfViewer: { currentPageNumber: 3 } } } },
    _primaryView: { initializedPromise: Promise.resolve(), _onSetOutline(outline) { calls.push('direct'); inner._updateState({ outline }); } },
    _updateState(update) { Object.assign(this._state, update); }, freeze() { calls.push('freeze'); }, unfreeze() { calls.push('unfreeze'); },
    toggleSidebar(value) { assert.equal(value, true); calls.push('sidebar'); },
    setSidebarView(value) { assert.equal(value, 'outline'); }
  };
  const reader = { itemID: 1, type: 'pdf', _iframeWindow: {}, _internalReader: inner, reload: async () => {
    calls.push('reload');
    const reloaded = await PDFLib.PDFDocument.load(await fs.readFile(file));
    // Mimics Zotero: cached outline, hidden lone parent, collapsed entries.
    inner._primaryView = { _outline: inner._state.outline,
      _onSetOutline(outline) { inner._updateState({ outline }); },
      async setSidebarView(value) {
        assert.equal(value, 'outline');
        if (this._outline) return;
        calls.push('getOutline2');
        const convert = e => ({ title: e.title, items: e.children.map(convert),
          location: { position: { pageIndex: e.pageIndex } } });
        let outline = Outline.tree(reloaded).map(convert);
        if (outline.length === 1 && outline[0].items.length > 1) outline = outline[0].items;
        this._outline = outline;
        this._onSetOutline(outline);
      }
    };
  } };
  let editable = true;
  const item = { id: 1, key: 'TESTKEY1', libraryID: 1, isPDFAttachment: () => true,
    isEditable: () => editable, getFilePathAsync: async () => file,
    get attachmentModificationTime() { return Promise.resolve(Date.now()); }, saveTx: async () => calls.push('saveTx') };
  const io = { read: async p => new Uint8Array(await fs.readFile(p)),
    exists: async p => { try { await fs.access(p); return true; } catch { return false; } },
    makeDirectory: p => fs.mkdir(p, { recursive: true }),
    write: async (p, b, options = {}) => {
      await fs.writeFile(options.tmpPath || p, b, { flag: options.noOverwrite ? 'wx' : 'w' });
      if (options.tmpPath) await fs.rename(options.tmpPath, p);
    }
  };
  const handlers = {};
  // Answers for the next prompts.
  let choice = 0; const asked = [];
  // Separate JS realms, as in Firefox.
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    Cu: { cloneInto: value => JSON.parse(JSON.stringify(value)) },
    IOUtils: io, PathUtils: path,
    Zotero: { initializationPromise: Promise.resolve(), DataDirectory: { dir },
      Items: { getAsync: async () => item }, Libraries: { get: () => ({ filesEditable: true }) },
      getMainWindow: () => null,
      Reader: { _readers: [reader], registerEventListener: (t,h) => { handlers[t]=h; },
        unregisterEventListener: (t,h) => { assert.equal(h,handlers[t]); calls.push('unregister ' + t); } }, logError: e=>{throw e;} },
    Services: { prompt: { BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536, BUTTON_TITLE_IS_STRING: 127, BUTTON_TITLE_CANCEL: 2,
        confirmEx: (w, t, message) => { asked.push(message); return choice; }, confirm: (w, t, message) => { asked.push(message); return choice === 0; } },
      scriptloader: { loadSubScriptWithOptions: (p, options) => {
      assert.equal(options.ignoreCache, true);
      vm.runInNewContext(syncFS.readFileSync(p,'utf8'), options.target, { filename: p });
    } } }
  });
  vm.runInContext(syncFS.readFileSync(path.join(__dirname,'../src/bootstrap.js'),'utf8'), context);
  await context.startup({ id: 'test', rootURI: path.resolve(__dirname, '../src') + '/' });
  const foreignBytes = await io.read(file);
  assert.equal(foreignBytes instanceof context.TOC.scope.Uint8Array, false);
  // Foreign bytes must fail to load directly.
  await assert.rejects(context.TOC.scope.PDFLib.PDFDocument.load(foreignBytes), /must be of type/);
  const loaded = await context.TOC.load(reader);
  assert.ok(loaded.bytes instanceof context.TOC.scope.Uint8Array);
  assert.equal(loaded.pdf.getPageCount(), 3);
  assert.equal(context.TOC.page(reader), 2);
  const titles = items => items.map(e => e.title + (e.items.length ? `(${titles(e.items)})` : '')).join(' ');
  const sidebar = () => titles(inner._state.outline);
  // Resolve a sidebar row as a right-click would.
  const row = n => { const { path, shape } = context.TOC.find(inner._state.outline, n); return { path: [...path], shape: [...shape] }; };
  assert.deepEqual(Object.keys(handlers).sort(), ['createViewContextMenu', 'renderToolbar']);
  // Headings Zotero detected: offered for saving, and kept on request.
  const heading = (title, y) => ({ title, sortIndex: '00000|000000|00000', items: [],
    location: { position: { pageIndex: 0, rects: [[50, y - 20, 200, y]] } } });
  inner._state.outline = [heading('Intro', 700), heading('Methods', 400)];
  const labels = entry => Array.from(context.TOC.menuItems(reader, entry, 1)).filter(Boolean).map(i => i[0]);
  assert.ok(labels(null).includes('Save detected headings to PDF'));
  choice = 1;
  assert.equal((await context.TOC.change(reader, { type:'add', title:'Chapter 3', pageIndex:2 })).length, 0);
  assert.deepEqual(await fs.readFile(file), Buffer.from(original));
  assert.match(asked.pop(), /These 2 headings were detected/);
  choice = 0;
  await context.TOC.change(reader, { type:'add', title:'Chapter 3', pageIndex:2 });
  assert.equal(sidebar(), 'Intro Methods Chapter 3');
  assert.deepEqual(inner._state.outline[1].location.position, { pageIndex: 0, rects: [[50, 400, 50, 400]] });
  // The sidebar is updated in place, without reloading the PDF.
  assert.ok(calls.includes('direct')); assert.ok(calls.includes('sidebar')); assert.ok(!calls.includes('reload'));
  assert.ok(!labels(null).includes('Save detected headings to PDF'));
  // Selected text in the PDF becomes an entry at that spot.
  const offered = [];
  context.TOC.viewMenu({ reader, append: item => offered.push(item) });
  assert.equal(offered.length, 0);
  inner._lastView._selectionRanges = [{ collapsed: false, text: ' Pre\nface ', position: { pageIndex: 1, rects: [[72, 600, 150, 620]] } }];
  context.TOC.viewMenu({ reader, append: item => offered.push(item) });
  assert.equal(offered[0].label, 'Add outline item');
  await offered[0].onCommand();
  assert.equal(sidebar(), 'Intro Methods Pre face Chapter 3');
  assert.deepEqual(inner._state.outline[2].location.position, { pageIndex: 1, rects: [[72, 620, 72, 620]] });
  await context.TOC.change(reader, { type:'remove', targets:[row(0), row(1), row(2)] });
  assert.equal(sidebar(), 'Chapter 3');
  assert.equal(inner._state.outline[0].location.position.pageIndex, 2);
  const changed = await fs.readFile(file);
  const backup = path.join(dir,'zotero-toc-backups/1-TESTKEY1');
  assert.deepEqual(await fs.readFile(path.join(backup,'original.pdf')), Buffer.from(original));
  await context.TOC.change(reader, { type:'rename', title:'Renamed', ...row(0) });
  assert.equal(sidebar(), 'Renamed');
  assert.deepEqual(await fs.readFile(path.join(backup,'previous.pdf')), changed);
  assert.deepEqual(await fs.readFile(path.join(backup,'original.pdf')), Buffer.from(original));
  editable = false;
  const before = await fs.readFile(file);
  await assert.rejects(context.TOC.change(reader,{type:'remove', ...row(0)}), /does not allow/);
  assert.deepEqual(await fs.readFile(file), before);
  editable = true;
  await context.TOC.change(reader, { type:'add', title:'Chapter 1', pageIndex:0 });
  assert.equal(sidebar(), 'Chapter 1 Renamed');
  // Nesting reopens the parent.
  await context.TOC.change(reader, { type:'add', title:'Section', pageIndex:1, where:'after', ...row(0) });
  await context.TOC.change(reader, { type:'move', direction:'indent', ...row(1) });
  assert.equal(sidebar(), 'Chapter 1(Section) Renamed');
  assert.equal(inner._state.outline[0].expanded, true);
  // Row numbers depend on what is expanded.
  assert.deepEqual(row(2).path, [1]);
  inner._state.outline[0].expanded = false;
  assert.deepEqual(row(1).path, [1]);
  inner._state.outline[0].expanded = true;
  // Open entries stay open.
  await context.TOC.change(reader, { type:'rename', title:'Chapter One', ...row(0) });
  assert.equal(inner._state.outline[0].expanded, true);
  await context.TOC.change(reader, { type:'move', direction:'up', ...row(2) });
  assert.equal(sidebar(), 'Renamed Chapter One(Section)');
  assert.equal(inner._state.outline[1].expanded, true);
  await context.TOC.change(reader, { type:'retarget', pageIndex:2, ...row(2) });
  assert.equal(inner._state.outline[1].items[0].location.position.pageIndex, 2);
  // Lone parent: Zotero lists its children as the top level.
  await context.TOC.change(reader, { type:'add', title:'Section 2', pageIndex:2, where:'child', ...row(1) });
  await context.TOC.change(reader, { type:'remove', ...row(0) });
  assert.equal(sidebar(), 'Section Section 2');
  await context.TOC.change(reader, { type:'rename', title:'Section 1', ...row(0) });
  assert.equal(sidebar(), 'Section 1 Section 2');
  assert.equal(titles(Outline.tree(await PDFLib.PDFDocument.load(await fs.readFile(file))).map(function c(e) {
    return { title: e.title, items: e.children.map(c) }; })), 'Chapter One(Section 1 Section 2)');
  // A stale sidebar is refused.
  const stale = await fs.readFile(file);
  await assert.rejects(context.TOC.change(reader, { type:'remove', path:[1], shape:[5] }), /out of date/);
  assert.deepEqual(await fs.readFile(file), stale);
  // Only possible moves are enabled.
  const menu = n => { const e = context.TOC.find(inner._state.outline, n);
    return Object.fromEntries(context.TOC.menuItems(reader, e, 1).filter(Boolean).map(([label,, on = true]) => [label, on])); };
  assert.equal(menu(0)['Move up'], false); assert.equal(menu(0)['Move down'], true);
  assert.equal(menu(1)['Nest under entry above'], true); assert.equal(menu(1)['Move down'], false);
  assert.ok('Add sub-entry for page 2…' in menu(0)); assert.ok('Delete…' in menu(0));
  assert.deepEqual(labels(null), ['Add entry for page 2…']);
  // Several entries at once; the moved entries are reported for reselection.
  const moved = await context.TOC.change(reader, { type:'move', direction:'down', targets:[row(0)] });
  assert.deepEqual(Array.from(moved, p => [...p]), [[1]]);
  assert.equal(sidebar(), 'Section 2 Section 1');
  await context.TOC.change(reader, { type:'move', direction:'up', targets:[row(1)] });
  assert.equal(sidebar(), 'Section 1 Section 2');
  await context.TOC.change(reader, { type:'move', direction:'outdent', ...row(1) });
  await context.TOC.change(reader, { type:'remove', ...row(0) });
  await context.TOC.change(reader, { type:'remove', ...row(0) });
  // With nothing saved, the PDF is reloaded so Zotero can detect headings again.
  assert.ok(calls.includes('reload')); assert.ok(calls.includes('getOutline2'));
  assert.deepEqual(inner._state.outline, []);
  assert.equal(context.TOC.scope.TOCOutline.tree((await context.TOC.load(reader)).pdf).length, 0);
  context.shutdown(); assert.ok(calls.includes('unregister renderToolbar')); assert.ok(calls.includes('unregister createViewContextMenu'));
  await assert.rejects(context.TOC.change(reader,{type:'remove',path:[0]}), /disabled/);
  await fs.rm(dir, { recursive:true });
});
