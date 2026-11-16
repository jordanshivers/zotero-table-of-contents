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
    _primaryView: { initializedPromise: Promise.resolve() },
    _updateState(update) { Object.assign(this._state, update); }, freeze() { calls.push('freeze'); }, unfreeze() { calls.push('unfreeze'); },
    toggleSidebar(value) { assert.equal(value, true); calls.push('sidebar'); },
    setSidebarView(value) { assert.equal(value, 'outline'); }
  };
  const reader = { itemID: 1, _internalReader: inner, reload: async () => {
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
  let handler;
  // Separate JS realms, as in Firefox.
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    IOUtils: io, PathUtils: path,
    Zotero: { initializationPromise: Promise.resolve(), DataDirectory: { dir },
      Items: { getAsync: async () => item }, Libraries: { get: () => ({ filesEditable: true }) },
      Reader: { _readers: [reader], registerEventListener: (t,h) => { assert.equal(t,'renderToolbar'); handler=h; },
        unregisterEventListener: (t,h) => { assert.equal(h,handler); calls.push('unregister'); } }, logError: e=>{throw e;} },
    Services: { scriptloader: { loadSubScriptWithOptions: (p, options) => {
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
  await context.TOC.change(reader, { type:'add', title:'Chapter 3', pageIndex:2 });
  assert.ok(calls.includes('reload')); assert.ok(calls.includes('sidebar')); assert.ok(calls.includes('getOutline2'));
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
  assert.deepEqual(Array.from(context.TOC.menuItems(reader, null, 1), i => i[0]), ['Add entry for page 2…']);
  // Several entries at once; the moved entries are reported for reselection.
  const moved = await context.TOC.change(reader, { type:'move', direction:'down', targets:[row(0)] });
  assert.deepEqual(Array.from(moved, p => [...p]), [[1]]);
  assert.equal(sidebar(), 'Section 2 Section 1');
  await context.TOC.change(reader, { type:'move', direction:'up', targets:[row(1)] });
  assert.equal(sidebar(), 'Section 1 Section 2');
  await context.TOC.change(reader, { type:'move', direction:'outdent', ...row(1) });
  await context.TOC.change(reader, { type:'remove', ...row(0) });
  await context.TOC.change(reader, { type:'remove', ...row(0) });
  assert.deepEqual(inner._state.outline, []);
  assert.equal(context.TOC.scope.TOCOutline.tree((await context.TOC.load(reader)).pdf).length, 0);
  context.shutdown(); assert.ok(calls.includes('unregister'));
  await assert.rejects(context.TOC.change(reader,{type:'remove',path:[0]}), /disabled/);
  await fs.rm(dir, { recursive:true });
});
