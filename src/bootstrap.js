/* global Zotero, Services, IOUtils, PathUtils */
var TOC;
async function startup({ id, rootURI }) {
  try {
    await Zotero.initializationPromise;
    // pdf-lib checks binary input with instanceof, so share our constructors.
    const scope = { setTimeout, clearTimeout, Uint8Array, ArrayBuffer };
    for (const file of ['vendor/pdf-lib.min.js', 'outline.js']) {
      Services.scriptloader.loadSubScriptWithOptions(rootURI + file, { target: scope, ignoreCache: true });
    }
    TOC = {
      id, scope, busy: new Set(), stopped: false, docs: new Map(),
      report(error) {
        Zotero.logError(error);
        Services.prompt.alert(Zotero.getMainWindow(), 'Zotero TOC', error.message || String(error));
      },
      page(reader) {
        const inner = reader._internalReader;
        const view = inner?._lastView;
        const number = view?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber;
        if (Number.isInteger(number) && number > 0) return number - 1;
        const stats = inner?._state?.[inner._lastViewPrimary === false ? 'secondaryViewStats' : 'primaryViewStats'];
        if (Number.isInteger(stats?.pageIndex)) return stats.pageIndex;
        throw new Error('Wait for the PDF to load, then try again.');
      },
      async load(reader) {
        const item = await Zotero.Items.getAsync(reader.itemID);
        if (!item?.isPDFAttachment()) throw new Error('Open a PDF attachment first.');
        const path = await item.getFilePathAsync();
        if (!path) throw new Error('Download this PDF before editing its contents.');
        const bytes = new Uint8Array(await IOUtils.read(path));
        const pdf = await scope.PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        return { item, path, bytes, pdf };
      },
      async change(reader, operation) {
        if (this.stopped) throw new Error('Zotero TOC has been disabled.');
        if (this.busy.has(reader.itemID)) throw new Error('A TOC change is already being saved for this PDF.');
        this.busy.add(reader.itemID);
        const views = Zotero.Reader._readers.filter(r => r.itemID === reader.itemID);
        try {
          const { item, path, bytes, pdf } = await this.load(reader);
          const library = Zotero.Libraries.get(item.libraryID);
          if (!item.isEditable() || !library.filesEditable) throw new Error('This library does not allow editing this PDF.');
          const expected = scope.TOCOutline.edit(pdf, operation);
          const output = await pdf.save({ useObjectStreams: false });
          // Verify the output before replacing the file.
          const check = await scope.PDFLib.PDFDocument.load(output, { updateMetadata: false });
          const saved = scope.TOCOutline.tree(check);
          if (check.getPageCount() !== pdf.getPageCount() || scope.TOCOutline.count(saved) !== expected.total ||
              (expected.path && scope.TOCOutline.at(saved, expected.path)?.title !== expected.title)) {
            throw new Error('PDF verification failed. The original file has not been changed.');
          }
          const shown = scope.TOCOutline.sidebarPath(saved, expected.path);
          const keepByPosition = operation.type === 'rename' || operation.type === 'retarget';
          const backupDir = PathUtils.join(Zotero.DataDirectory.dir, 'zotero-toc-backups', `${item.libraryID}-${item.key}`);
          await IOUtils.makeDirectory(backupDir, { createAncestors: true });
          const original = PathUtils.join(backupDir, 'original.pdf');
          if (!(await IOUtils.exists(original))) await IOUtils.write(original, bytes, { noOverwrite: true });
          await IOUtils.write(PathUtils.join(backupDir, 'previous.pdf'), bytes, { tmpPath: PathUtils.join(backupDir, 'previous.tmp') });
          // Don't overwrite a file that changed meanwhile.
          const current = await IOUtils.read(path);
          if (current.length !== bytes.length || current.some((v, i) => v !== bytes[i])) {
            throw new Error('The PDF changed while saving. Please try again.');
          }
          for (const r of views) r._internalReader.freeze();
          await IOUtils.write(path, output, { tmpPath: path + '.zotero-toc.tmp' });
          // As Zotero does after its own page edits.
          item.attachmentLastProcessedModificationTime = Math.floor((await item.attachmentModificationTime) / 1000);
          await item.saveTx({ skipAll: true });
          for (const r of views) {
            const open = this.expanded(r._internalReader._state.outline, keepByPosition);
            await r.reload();
            const inner = r._internalReader;
            const view = inner._primaryView;
            // The reloaded view inherits the cached outline; clear it to force a re-read.
            view._outline = null;
            await view.setSidebarView('outline');
            try {
              // Reopen entries that were open.
              const outline = inner._state.outline;
              if (outline && this.expand(outline, open, shown, keepByPosition)) view._onSetOutline(outline.slice());
            } catch (e) { Zotero.logError(e); }
            inner.toggleSidebar(true);
            inner.setSidebarView('outline');
          }
        } finally {
          for (const r of views) {
            try { r._internalReader.unfreeze(); } catch (e) { Zotero.logError(e); }
          }
          this.busy.delete(reader.itemID);
        }
      },
      // Keyed by position, or by titles when positions will change.
      expanded(outline, byPosition) {
        const open = new Set();
        const walk = (items, prefix) => {
          for (let i = 0; i < (items?.length || 0); i++) {
            const item = items[i], id = prefix + '\u0000' + (byPosition ? i : item.title);
            if (item.expanded) open.add(id);
            walk(item.items, id);
          }
        };
        try { walk(outline, ''); } catch (e) { Zotero.logError(e); }
        return open;
      },
      expand(outline, open, path, byPosition) {
        let changed = false;
        const walk = (items, prefix) => {
          for (let i = 0; i < (items?.length || 0); i++) {
            const item = items[i], id = prefix + '\u0000' + (byPosition ? i : item.title);
            if (item.items?.length && open.has(id)) { item.expanded = true; changed = true; }
            walk(item.items, id);
          }
        };
        walk(outline, '');
        let items = outline;
        for (const index of (path || []).slice(0, -1)) {
          const item = items?.[index];
          if (!item) break;
          item.expanded = true; changed = true;
          items = item.items;
        }
        return changed;
      },
      // Rows are numbered top-down, skipping children of collapsed entries.
      find(outline, row) {
        let counter = -1, found = null;
        const walk = (items, path, shape) => {
          for (let i = 0; i < items.length && !found; i++) {
            const item = items[i];
            counter++;
            const here = [...path, i], counts = [...shape, items.length];
            if (counter === row) { found = { item, path: here, shape: counts, index: i, siblings: items.length }; return; }
            const rendered = item.matched !== false || item.childMatched !== false;
            if (rendered && item.expanded && item.items) walk(item.items, here, counts);
          }
        };
        walk(outline || [], [], []);
        return found;
      },
      currentPage(reader) {
        try { return this.page(reader); } catch (e) { return null; }
      },
      askTitle(heading, label, initial = '') {
        const value = { value: initial };
        return Services.prompt.prompt(Zotero.getMainWindow(), heading, label, value, null, {}) ? value.value : null;
      },
      async add(reader, pageIndex = this.page(reader), placement = {}) {
        const title = this.askTitle('Add table of contents entry', `Title for PDF page ${pageIndex + 1}:`);
        if (title === null) return;
        await this.change(reader, { type: 'add', pageIndex, title, ...placement });
      },
      async run(action) {
        try { await action(); } catch (e) { this.report(e); }
      },
      closeMenu(doc) {
        const menu = doc.getElementById('zotero-toc-menu');
        if (!menu) return;
        menu.remove();
        const state = this.docs.get(doc);
        if (state?.dismiss) {
          doc.removeEventListener('pointerdown', state.dismiss, true);
          doc.defaultView?.removeEventListener('blur', state.dismiss);
          state.dismiss = null;
        }
      },
      // entry is null for the empty part of the list.
      menuItems(reader, entry, page) {
        const here = entry && { path: entry.path, shape: entry.shape };
        const move = direction => () => this.change(reader, { type: 'move', direction, ...here });
        const forPage = page === null ? null : `page ${page + 1}`;
        if (!entry) return forPage ? [[`Add entry for ${forPage}…`, () => this.add(reader, page)]] : [];
        const descendants = (function total(items) {
          let n = 0;
          for (let i = 0; i < (items?.length || 0); i++) n += 1 + total(items[i].items);
          return n;
        })(entry.item.items);
        const title = String(entry.item.title || '');
        return [
          ['Rename…', async () => {
            const value = this.askTitle('Rename TOC entry', 'Title:', title);
            if (value !== null && value.trim() !== title) await this.change(reader, { type: 'rename', title: value, ...here });
          }],
          forPage && [`Point to current page (${forPage})`, () => this.change(reader, { type: 'retarget', pageIndex: page, ...here })],
          null,
          forPage && [`Add entry below for ${forPage}…`, () => this.add(reader, page, { where: 'after', ...here })],
          forPage && [`Add sub-entry for ${forPage}…`, () => this.add(reader, page, { where: 'child', ...here })],
          null,
          ['Move up', move('up'), entry.index > 0],
          ['Move down', move('down'), entry.index < entry.siblings - 1],
          ['Nest under entry above', move('indent'), entry.index > 0],
          ['Move out one level', move('outdent'), entry.path.length > 1],
          null,
          ['Delete…', async () => {
            const extra = descendants ? ` and its ${descendants} sub-${descendants === 1 ? 'entry' : 'entries'}` : '';
            if (Services.prompt.confirm(Zotero.getMainWindow(), 'Delete TOC entry',
              `Remove “${title}”${extra} from this PDF’s contents?`)) await this.change(reader, { type: 'remove', ...here });
          }]
        ];
      },
      openMenu(reader, doc, x, y, entry, page) {
        this.closeMenu(doc);
        const items = this.menuItems(reader, entry, page);
        if (!items.some(Boolean)) return;
        const menu = doc.createElement('div');
        menu.id = 'zotero-toc-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Table of contents entry');
        menu.style.cssText = 'position:fixed;z-index:10001;min-width:210px;max-width:320px;padding:4px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;box-shadow:0 6px 24px #0005;font:13px system-ui;';
        let separate = false;
        for (const item of items) {
          if (!item) { separate = menu.childElementCount > 0; continue; }
          const [label, action, enabled = true] = item;
          if (separate) {
            const line = doc.createElement('div');
            line.style.cssText = 'height:1px;margin:4px 6px;background:GrayText;opacity:.4;';
            menu.append(line);
            separate = false;
          }
          const b = doc.createElement('button');
          b.type = 'button'; b.textContent = label; b.disabled = !enabled;
          b.setAttribute('role', 'menuitem');
          b.style.cssText = 'display:block;width:100%;padding:5px 10px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:start;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
            (enabled ? 'cursor:pointer;' : 'opacity:.45;');
          if (enabled) {
            const highlight = on => { b.style.background = on ? 'SelectedItem' : 'transparent'; b.style.color = on ? 'SelectedItemText' : 'inherit'; };
            b.addEventListener('mouseenter', () => { b.focus(); highlight(true); });
            b.addEventListener('mouseleave', () => highlight(false));
            b.addEventListener('focus', () => highlight(true));
            b.addEventListener('blur', () => highlight(false));
            b.addEventListener('click', () => { this.closeMenu(doc); this.run(action); });
          }
          menu.append(b);
        }
        menu.addEventListener('keydown', e => {
          const buttons = [], all = menu.querySelectorAll('button:not(:disabled)');
          for (let i = 0; i < all.length; i++) buttons.push(all[i]);
          const at = buttons.indexOf(doc.activeElement);
          if (e.key === 'Escape') this.closeMenu(doc);
          else if (e.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus();
          else if (e.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
          if (e.key.startsWith('Arrow')) e.preventDefault();
          // Don't let keys reach the list underneath.
          e.stopPropagation();
        });
        menu.addEventListener('contextmenu', e => e.preventDefault());
        doc.body.append(menu);
        const win = doc.defaultView, box = menu.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(x, win.innerWidth - box.width - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(y, win.innerHeight - box.height - 4)) + 'px';
        const state = this.docs.get(doc);
        state.dismiss = e => { if (e.type === 'blur' || !menu.contains(e.target)) this.closeMenu(doc); };
        doc.addEventListener('pointerdown', state.dismiss, true);
        win.addEventListener('blur', state.dismiss);
        menu.querySelector('button:not(:disabled)')?.focus();
      },
      // A closed reader's document throws "can't access dead object".
      closed(doc) {
        try { return !doc.defaultView; } catch (e) { return true; }
      },
      attach(reader, doc) {
        // Drop closed tabs.
        for (const known of [...this.docs.keys()]) if (this.closed(known)) this.docs.delete(known);
        // The same page can arrive under two wrappers.
        if (this.docs.has(doc) || [...this.docs.values()].some(known => known.reader === reader)) return;
        const inList = e => {
          const node = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
          return node?.closest('#outlineView') ? node : null;
        };
        const state = { reader, dismiss: null, page: null, pageTime: 0 };
        state.pointerdown = e => {
          if (!(e.button === 2 || (e.button === 0 && e.ctrlKey && Zotero.isMac)) || !inList(e)) return;
          // Zotero navigates on any mouse button; remember the page and block that.
          state.page = this.currentPage(reader); state.pageTime = Date.now();
          e.stopPropagation();
        };
        state.contextmenu = e => {
          const node = inList(e);
          if (!node || this.stopped) return;
          e.preventDefault(); e.stopPropagation();
          // Keyboard-opened menu (input source 6): use the highlighted entry.
          const row = node.closest('.item') || (e.mozInputSource === 6 ? doc.querySelector('#outlineView .item.active') : null);
          let entry = null, x = e.clientX, y = e.clientY;
          if (row && !node.closest('.item')) ({ left: x, bottom: y } = row.getBoundingClientRect());
          if (row) {
            entry = this.find(reader._internalReader._state.outline, Number(row.dataset.id));
            if (!entry) return;
          }
          const page = Date.now() - state.pageTime < 3000 ? state.page : this.currentPage(reader);
          this.openMenu(reader, doc, x, y, entry, page);
        };
        doc.addEventListener('pointerdown', state.pointerdown, true);
        doc.addEventListener('contextmenu', state.contextmenu, true);
        this.docs.set(doc, state);
        // The sidebar is rebuilt whenever it opens, so keep re-adding the button.
        const ensure = () => {
          state.timer = null;
          if (this.stopped || this.docs.get(doc) !== state) return;
          if (this.closed(doc)) { this.docs.delete(doc); return; }
          try {
            const list = doc.getElementById('outlineView');
            if (list && !doc.getElementById('zotero-toc-add')) list.parentNode.insertBefore(this.addButton(reader, doc), list);
          } catch (e) {
            if (this.closed(doc)) { this.docs.delete(doc); return; }
            if (!this.buttonFailed) {
              this.buttonFailed = true;
              this.report(new Error('Zotero TOC could not add its button to the contents sidebar: ' + (e.message || e)));
            }
            return;
          }
          state.timer = setTimeout(ensure, 400);
        };
        ensure();
      },
      detach() {
        for (const [doc, state] of this.docs) {
          try {
            this.closeMenu(doc);
            doc.removeEventListener('pointerdown', state.pointerdown, true);
            doc.removeEventListener('contextmenu', state.contextmenu, true);
            if (state.timer) clearTimeout(state.timer);
            doc.getElementById('zotero-toc-add')?.remove();
          } catch (e) { Zotero.logError(e); }
        }
        this.docs.clear();
      },
      addButton(reader, doc) {
        const bar = doc.createElement('div');
        bar.id = 'zotero-toc-add';
        bar.style.cssText = 'position:sticky;top:0;z-index:1;padding:6px 8px 2px;background:var(--material-sidepane, Canvas);';
        const b = doc.createElement('button'); b.type = 'button'; b.textContent = '+ Add entry for this page';
        b.title = 'Add a table of contents entry for the page you are reading. Right-click an entry to rename, move, nest, or delete it.';
        b.style.cssText = 'display:block;width:100%;font:inherit;font-size:12px;padding:4px 7px;border:1px solid GrayText;border-radius:4px;background:ButtonFace;color:ButtonText;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        b.addEventListener('click', () => this.run(() => this.add(reader)));
        bar.append(b);
        return bar;
      },
      // Fired per reader; used only to find its document.
      render({ reader, doc }) {
        if (reader.type === 'pdf') this.attach(reader, doc);
      }
    };
    TOC.handler = TOC.render.bind(TOC);
    Zotero.Reader.registerEventListener('renderToolbar', TOC.handler, id);
    for (const reader of Zotero.Reader._readers) {
      const doc = reader._iframeWindow?.document;
      if (doc && reader.type === 'pdf') TOC.attach(reader, doc);
    }
  } catch (e) {
    Zotero.logError(e);
    Services.prompt.alert(null, 'Zotero TOC', 'Zotero TOC could not start: ' + (e.message || e));
    throw e;
  }
}
function shutdown() {
  if (!TOC) return;
  TOC.stopped = true;
  Zotero.Reader.unregisterEventListener('renderToolbar', TOC.handler);
  TOC.detach();
  for (const reader of Zotero.Reader._readers) {
    const doc = reader._iframeWindow?.document;
    doc?.querySelectorAll('.zotero-toc-controls, #zotero-toc-menu').forEach(n => n.remove());
  }
}
function install() {}
function uninstall() {}
