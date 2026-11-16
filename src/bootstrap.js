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
          const shown = (expected.paths || [expected.path]).map(p => scope.TOCOutline.sidebarPath(saved, p)).filter(Boolean);
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
          for (const state of this.docs.values()) if (views.includes(state.reader)) state.selected.clear();
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
          return shown;
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
      expand(outline, open, paths, byPosition) {
        let changed = false;
        const walk = (items, prefix) => {
          for (let i = 0; i < (items?.length || 0); i++) {
            const item = items[i], id = prefix + '\u0000' + (byPosition ? i : item.title);
            if (item.items?.length && open.has(id)) { item.expanded = true; changed = true; }
            walk(item.items, id);
          }
        };
        walk(outline, '');
        for (const path of paths) {
          let items = outline;
          for (const index of path.slice(0, -1)) {
            const item = items?.[index];
            if (!item) break;
            item.expanded = true; changed = true;
            items = item.items;
          }
        }
        return changed;
      },
      // Rows are numbered top-down, skipping children of collapsed entries.
      rows(outline) {
        const rows = [];
        const walk = (items, path, shape) => {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const here = [...path, i], counts = [...shape, items.length];
            rows.push({ item, path: here, shape: counts, index: i, siblings: items.length, key: here.join(',') });
            const rendered = item.matched !== false || item.childMatched !== false;
            if (rendered && item.expanded && item.items) walk(item.items, here, counts);
          }
        };
        walk(outline || [], [], []);
        return rows;
      },
      find(outline, row) {
        return this.rows(outline)[row] || null;
      },
      // Highlight selected rows; forget entries that are no longer listed.
      paint(reader, doc) {
        const state = this.docs.get(doc);
        if (!state || this.closed(doc)) return;
        const rows = this.rows(reader._internalReader._state.outline);
        const listed = new Set(rows.map(r => r.key));
        for (const key of [...state.selected]) if (!listed.has(key)) state.selected.delete(key);
        const items = doc.querySelectorAll('#outlineView .item');
        for (let i = 0; i < items.length; i++) {
          const on = state.selected.has(rows[Number(items[i].dataset.id)]?.key);
          if (on !== (items[i].dataset.tocSelected === '1')) {
            items[i].dataset.tocSelected = on ? '1' : '';
            items[i].style.background = on ? 'color-mix(in srgb, SelectedItem 40%, transparent)' : '';
          }
        }
      },
      // Menu for several selected entries.
      bulkItems(reader, state, entries) {
        const targets = entries.map(e => ({ path: e.path, shape: e.shape }));
        const move = direction => async () => {
          const shown = await this.change(reader, { type: 'move', direction, targets });
          for (const path of shown) state.selected.add(path.join(','));
        };
        return [
          ['Move up', move('up')],
          ['Move down', move('down')],
          ['Nest under entry above', move('indent')],
          ['Move out one level', move('outdent')],
          null,
          [`Delete ${entries.length} entries…`, async () => {
            if (Services.prompt.confirm(Zotero.getMainWindow(), 'Delete TOC entries',
              `Remove these ${entries.length} entries and their sub-entries from this PDF’s contents?`)) await this.change(reader, { type: 'remove', targets });
          }]
        ];
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
      openMenu(reader, doc, x, y, items) {
        this.closeMenu(doc);
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
            b.addEventListener('click', async () => { this.closeMenu(doc); await this.run(action); this.paint(reader, doc); });
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
        const state = { reader, dismiss: null, page: null, pageTime: 0, selected: new Set(), anchor: null };
        const accel = e => Zotero.isMac ? e.metaKey : e.ctrlKey;
        const rightClick = e => e.button === 2 || (e.button === 0 && e.ctrlKey && Zotero.isMac);
        const entryOf = (rows, row) => row ? rows[Number(row.dataset.id)] : null;
        // Cmd/Ctrl-click or Shift-click on an entry selects instead of navigating.
        const selecting = e => e.button === 0 && !rightClick(e) && (accel(e) || e.shiftKey) &&
          inList(e)?.closest('.item') && !inList(e).closest('.toggle');
        state.pointerdown = e => {
          const node = inList(e);
          if (!node || this.stopped) return;
          if (rightClick(e)) {
            // Zotero navigates on any mouse button; remember the page and block that.
            state.page = this.currentPage(reader); state.pageTime = Date.now();
            e.stopPropagation();
            return;
          }
          if (e.button !== 0 || node.closest('.toggle')) return;
          const rows = this.rows(reader._internalReader._state.outline);
          const entry = entryOf(rows, node.closest('.item'));
          if (!entry || !selecting(e)) {
            // Plain click: Zotero navigates; start over from here.
            state.selected.clear();
            state.anchor = entry?.key ?? null;
          } else {
            e.stopPropagation(); e.preventDefault();
            if (e.shiftKey) {
              let from = rows.findIndex(r => r.key === state.anchor);
              if (from < 0) { from = rows.indexOf(entry); state.anchor = entry.key; }
              const to = rows.indexOf(entry);
              if (!accel(e)) state.selected.clear();
              for (let i = Math.min(from, to); i <= Math.max(from, to); i++) state.selected.add(rows[i].key);
            } else {
              if (!state.selected.delete(entry.key)) state.selected.add(entry.key);
              state.anchor = entry.key;
            }
          }
          this.paint(reader, doc);
        };
        // Keep Shift-click from selecting text.
        state.mousedown = e => { if (selecting(e)) e.preventDefault(); };
        state.contextmenu = e => {
          const node = inList(e);
          if (!node || this.stopped) return;
          e.preventDefault(); e.stopPropagation();
          // Keyboard-opened menu (input source 6): use the highlighted entry.
          const row = node.closest('.item') || (e.mozInputSource === 6 ? doc.querySelector('#outlineView .item.active') : null);
          let entry = null, x = e.clientX, y = e.clientY;
          if (row && !node.closest('.item')) ({ left: x, bottom: y } = row.getBoundingClientRect());
          const rows = this.rows(reader._internalReader._state.outline);
          if (row) {
            entry = entryOf(rows, row);
            if (!entry) return;
          }
          // Cmd/Ctrl-right-click adds to or removes from the selection.
          if (entry && accel(e) && !(Zotero.isMac && e.ctrlKey)) {
            if (!state.selected.delete(entry.key)) state.selected.add(entry.key);
            state.anchor = entry.key;
            this.paint(reader, doc);
            return;
          }
          if (!entry || !state.selected.has(entry.key)) state.selected.clear();
          this.paint(reader, doc);
          const page = Date.now() - state.pageTime < 3000 ? state.page : this.currentPage(reader);
          const chosen = rows.filter(r => state.selected.has(r.key));
          this.openMenu(reader, doc, x, y, chosen.length > 1 ? this.bulkItems(reader, state, chosen) : this.menuItems(reader, entry, page));
        };
        doc.addEventListener('pointerdown', state.pointerdown, true);
        doc.addEventListener('mousedown', state.mousedown, true);
        doc.addEventListener('contextmenu', state.contextmenu, true);
        this.docs.set(doc, state);
        // The sidebar is rebuilt whenever it opens, so keep re-adding the button and highlights.
        const ensure = () => {
          state.timer = null;
          if (this.stopped || this.docs.get(doc) !== state) return;
          if (this.closed(doc)) { this.docs.delete(doc); return; }
          try {
            const list = doc.getElementById('outlineView');
            if (list && !doc.getElementById('zotero-toc-add')) list.parentNode.insertBefore(this.addButton(reader, doc), list);
            if (list) try { this.paint(reader, doc); } catch (e) { Zotero.logError(e); }
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
            doc.removeEventListener('mousedown', state.mousedown, true);
            doc.removeEventListener('contextmenu', state.contextmenu, true);
            state.selected.clear();
            this.paint(state.reader, doc);
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
        b.title = 'Add a table of contents entry for the page you are reading. Right-click an entry to rename, move, nest, or delete it. ' +
          (Zotero.isMac ? 'Cmd' : 'Ctrl') + '-click or Shift-click to select several.';
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
