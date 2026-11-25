/* PDF outline editing. Entries are addressed by path: sibling indexes from the top level down. */
var TOCOutline = (() => {
  const key = name => PDFLib.PDFName.of(name);
  const STALE = 'The contents list is out of date. Close and reopen the PDF, then try again.';
  function dict(pdf, value) {
    const result = pdf.context.lookup(value);
    if (!(result instanceof PDFLib.PDFDict)) throw new Error('Invalid PDF outline structure. No changes saved.');
    return result;
  }
  function root(pdf, create = false) {
    let ref = pdf.catalog.get(key('Outlines'));
    if (!ref && create) {
      ref = pdf.context.register(pdf.context.obj({ Type: 'Outlines', Count: 0 }));
      pdf.catalog.set(key('Outlines'), ref);
    }
    return ref ? { ref, node: dict(pdf, ref) } : null;
  }
  // In-memory copy of the outline: { ref, node, parent, children }.
  function model(pdf, create = false) {
    const r = root(pdf, create);
    const top = { ref: r?.ref, node: r?.node, parent: null, children: [] };
    if (!r) return top;
    const seen = new Set();
    (function fill(m, depth) {
      if (depth > 200) throw new Error('Circular or oversized PDF outline.');
      let ref = m.node.get(key('First'));
      while (ref) {
        if (!(ref instanceof PDFLib.PDFRef)) throw new Error('Invalid PDF outline structure. No changes saved.');
        const id = ref.toString();
        if (seen.has(id) || seen.size > 100000) throw new Error('Circular or oversized PDF outline.');
        seen.add(id);
        const child = { ref, node: dict(pdf, ref), parent: m, children: [] };
        m.children.push(child);
        fill(child, depth + 1);
        ref = child.node.get(key('Next'));
      }
    })(top, 0);
    return top;
  }
  function text(node, name) {
    return node.lookup(key(name))?.decodeText?.() || '';
  }
  const pageMaps = new WeakMap();
  function destination(node) {
    let dest = node.lookup(key('Dest'));
    if (!dest) {
      const action = node.lookup(key('A'));
      if (action instanceof PDFLib.PDFDict) dest = action.lookup(key('D'));
    }
    return dest instanceof PDFLib.PDFArray ? dest : null;
  }
  function pageIndex(pdf, node) {
    let pages = pageMaps.get(pdf);
    if (!pages) pageMaps.set(pdf, pages = new Map(pdf.getPages().map((p, i) => [p.ref.toString(), i])));
    const index = pages.get(destination(node)?.get(0)?.toString());
    return index === undefined ? null : index;
  }
  // Where an entry lands on its page, worked out the way Zotero does.
  function spot(pdf, node) {
    const index = pageIndex(pdf, node);
    if (index === null) return { pageIndex: null, top: null, left: null };
    const dest = destination(node), page = pdf.getPage(index), box = page.getCropBox();
    const number = i => { const v = dest.lookup(i); return v instanceof PDFLib.PDFNumber ? v.asNumber() : null; };
    const height = page.getRotation().angle % 180 ? box.width : box.height;
    const kind = dest.get(1)?.toString();
    let left = 0, top = height;
    if (kind === '/XYZ') { left = number(2) ?? 0; top = number(3) ?? height; }
    else if (kind === '/FitH' || kind === '/FitBH') top = number(2) ?? height;
    else if (kind === '/FitV' || kind === '/FitBV') left = number(2) ?? 0;
    else if (kind === '/FitR') { left = number(2) ?? 0; top = number(5) ?? height; }
    const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
    return { pageIndex: index, top: clamp(top, box.y, box.y + box.height), left: clamp(left, box.x, box.x + box.width) };
  }
  // Zotero's sidebar hides a lone top-level entry with several children.
  function sidebarTop(top) {
    return top.children.length === 1 && top.children[0].children.length > 1 ? top.children[0] : top;
  }
  function tree(pdf) {
    const convert = m => ({ title: text(m.node, 'Title'), ...spot(pdf, m.node), children: m.children.map(convert) });
    return model(pdf).children.map(convert);
  }
  function at(items, path) {
    let node = null;
    for (const index of path) {
      node = items?.[index];
      if (!node) return null;
      items = node.children;
    }
    return node;
  }
  function count(items) {
    return items.reduce((n, item) => n + 1 + count(item.children), 0);
  }
  // PDF path to sidebar path.
  function sidebarPath(items, path) {
    if (!path) return null;
    if (items.length === 1 && items[0].children.length > 1) return path.length > 1 ? path.slice(1) : null;
    return path;
  }
  function title(value) {
    value = String(value).trim();
    if (!value || value.length > 500) throw new Error('Enter a title between 1 and 500 characters.');
    return PDFLib.PDFHexString.fromText(value);
  }
  function ensureEditable(pdf) {
    if (pdf.isEncrypted) throw new Error('Encrypted PDFs cannot be edited by Zotero Table of Contents.');
    if (pdf.catalog.has(key('Perms'))) throw new Error('This PDF has document permissions or a certification signature.');
    // Includes signatures in nested form fields.
    for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFLib.PDFDict &&
          (obj.get(key('FT'))?.toString() === '/Sig' || obj.get(key('Type'))?.toString() === '/Sig')) {
        throw new Error('Digitally signed PDFs are not edited because editing would invalidate their signatures.');
      }
    }
  }
  // `shape` is the sibling count the sidebar showed at each level.
  // `direct` skips the sidebar's lone-parent rule (headings that were just saved).
  function locate(top, path, shape, direct) {
    if (!Array.isArray(path) || !path.length) throw new Error(STALE);
    if (!top.children.length) {
      throw new Error('Zotero detected these headings itself. They are not saved in the PDF, so they cannot be edited. Add your own entries instead.');
    }
    let m = direct ? top : sidebarTop(top);
    path.forEach((index, depth) => {
      if ((shape && m.children.length !== shape[depth]) || !m.children[index]) throw new Error(STALE);
      m = m.children[index];
    });
    return m;
  }
  function link(node, name, ref) { if (ref) node.set(key(name), ref); else node.delete(key(name)); }
  function relink(m) {
    const c = m.children;
    link(m.node, 'First', c[0]?.ref);
    link(m.node, 'Last', c[c.length - 1]?.ref);
    c.forEach((child, i) => {
      child.parent = m;
      child.node.set(key('Parent'), m.ref);
      link(child.node, 'Prev', c[i - 1]?.ref);
      link(child.node, 'Next', c[i + 1]?.ref);
    });
  }
  // Visible descendants; negative when collapsed.
  function recount(m) {
    let visible = 0;
    for (const child of m.children) visible += 1 + recount(child);
    if (!m.parent) { m.node.set(key('Count'), PDFLib.PDFNumber.of(visible)); return visible; }
    if (!m.children.length) { m.node.delete(key('Count')); return 0; }
    const old = m.node.lookup(key('Count'));
    const closed = old instanceof PDFLib.PDFNumber && old.asNumber() < 0;
    m.node.set(key('Count'), PDFLib.PDFNumber.of(closed ? -visible : visible));
    return closed ? 0 : visible;
  }
  function size(m) { return m.children.reduce((n, child) => n + 1 + size(child), 0); }
  function realPath(m) {
    const path = [];
    for (; m.parent; m = m.parent) path.unshift(m.parent.children.indexOf(m));
    return path;
  }
  function pageRef(pdf, p) {
    if (!Number.isInteger(p) || p < 0 || p >= pdf.getPageCount()) throw new Error('The current PDF page is unavailable.');
    return pdf.getPage(p).ref;
  }
  function place(pdf, p, top, left) {
    const ref = pageRef(pdf, p);
    return Number.isFinite(top) ? [ref, 'XYZ', Number.isFinite(left) ? left : null, top, null] : [ref, 'Fit'];
  }
  // Writes headings Zotero detected: [{ title, pageIndex, top, left, children }].
  function plant(pdf, top, seed) {
    let last = 0, total = 0;
    (function fill(parent, items, depth) {
      if (depth > 50) return;
      for (const item of items || []) {
        if (++total > 20000) throw new Error('Too many headings to save.');
        const known = Number.isInteger(item.pageIndex) && item.pageIndex >= 0 && item.pageIndex < pdf.getPageCount();
        if (known) last = item.pageIndex;
        const name = String(item.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || 'Untitled';
        const node = pdf.context.obj({ Title: PDFLib.PDFHexString.fromText(name),
          Dest: known ? place(pdf, last, item.top, item.left) : place(pdf, last) });
        const child = { ref: pdf.context.register(node), node, parent, children: [] };
        parent.children.push(child);
        fill(child, item.children, depth + 1);
      }
      relink(parent);
    })(top, seed, 0);
    recount(top);
  }
  // Orphaned objects are kept; others may reference them.
  function drop(m) {
    m.parent.children.splice(m.parent.children.indexOf(m), 1);
    relink(m.parent);
  }
  function shift(m, d) {
    const parent = m.parent, index = parent.children.indexOf(m);
    if (d === 'up' || d === 'down') {
      const other = index + (d === 'up' ? -1 : 1);
      if (!parent.children[other]) throw new Error(`This entry is already ${d === 'up' ? 'first' : 'last'}.`);
      parent.children[index] = parent.children[other];
      parent.children[other] = m;
      relink(parent);
    } else if (d === 'indent') {
      const previous = parent.children[index - 1];
      if (!previous) throw new Error('There is no entry above this one to nest it under.');
      parent.children.splice(index, 1);
      previous.children.push(m);
      relink(parent); relink(previous);
    } else if (d === 'outdent') {
      const grand = parent.parent;
      if (!grand) throw new Error('This entry is already at the top level.');
      parent.children.splice(index, 1);
      grand.children.splice(grand.children.indexOf(parent) + 1, 0, m);
      relink(parent); relink(grand);
    } else throw new Error('Unknown TOC operation.');
  }
  // Document order of two paths.
  function order(a, b) {
    for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  }
  /* Operations (paths are sidebar paths):
   *   add      { title, pageIndex, where?: 'child' | 'after', path? }
   *   rename   { path, title }
   *   retarget { path, pageIndex }
   *   move     { path, direction: 'up' | 'down' | 'indent' | 'outdent' }
   *   remove   { path }
   *   import   { seed }
   * move and remove also take { targets: [{ path, shape }] } in place of path.
   * add takes optional top/left for a spot on the page. Any operation may carry
   * `seed`, headings to save first into a PDF that has none.
   * Returns { path, title, total } for verifying the saved file.
   */
  function edit(pdf, operation) {
    ensureEditable(pdf);
    const { type, path, shape } = operation;
    const seeded = !!operation.seed;
    let target = null, top;
    if (seeded) {
      top = model(pdf, true);
      if (top.children.length) throw new Error(STALE);
      plant(pdf, top, operation.seed);
    }
    if (type === 'import') {
      if (!seeded) throw new Error('Unknown TOC operation.');
    } else if (type === 'add') {
      pageRef(pdf, operation.pageIndex);
      const t = title(operation.title);
      top = model(pdf, true);
      let parent = top, index = -1;
      if (operation.where) {
        const picked = locate(top, path, shape, seeded);
        if (operation.where === 'after') { parent = picked.parent; index = parent.children.indexOf(picked) + 1; }
        else if (operation.where === 'child') parent = picked;
        else throw new Error('Unknown TOC operation.');
      }
      if (index < 0) {
        // Insert before the first later page.
        index = parent.children.findIndex(x => { const i = pageIndex(pdf, x.node); return i !== null && i > operation.pageIndex; });
        if (index < 0) index = parent.children.length;
      }
      const node = pdf.context.obj({ Title: t, Dest: place(pdf, operation.pageIndex, operation.top, operation.left) });
      target = { ref: pdf.context.register(node), node, parent, children: [] };
      parent.children.splice(index, 0, target);
      relink(parent);
      recount(top);
    } else if (operation.targets) {
      // Several entries at once: move or remove only.
      if (type !== 'move' && type !== 'remove') throw new Error('Unknown TOC operation.');
      top = model(pdf);
      const picked = new Set(operation.targets.map(t => locate(top, t.path, t.shape, seeded)));
      // Sub-entries follow a selected ancestor.
      const nodes = [...picked].filter(m => {
        for (let p = m.parent; p; p = p.parent) if (picked.has(p)) return false;
        return true;
      }).map(m => [realPath(m), m]).sort((a, b) => order(a[0], b[0])).map(x => x[1]);
      if (!nodes.length) throw new Error(STALE);
      const d = operation.direction;
      // Work from the far end so entries keep their relative order.
      if (type === 'move' && (d === 'down' || d === 'outdent')) nodes.reverse();
      for (const m of nodes) { if (type === 'remove') drop(m); else shift(m, d); }
      recount(top);
      if (type === 'move') {
        const moved = nodes.map(m => [realPath(m), m]).sort((x, y) => order(x[0], y[0]));
        return { path: moved[0][0], title: text(moved[0][1].node, 'Title'), total: size(top), paths: moved.map(x => x[0]) };
      }
    } else {
      top = model(pdf);
      target = locate(top, path, shape, seeded);
      if (type === 'rename') target.node.set(key('Title'), title(operation.title));
      else if (type === 'retarget') {
        target.node.set(key('Dest'), pdf.context.obj([pageRef(pdf, operation.pageIndex), 'Fit']));
        target.node.delete(key('A'));
      } else if (type === 'remove') {
        drop(target);
        recount(top);
        target = null;
      } else if (type === 'move') {
        shift(target, operation.direction);
        recount(top);
      } else throw new Error('Unknown TOC operation.');
    }
    return { path: target && realPath(target), title: target ? text(target.node, 'Title') : null, total: size(top) };
  }
  return { tree, at, count, sidebarPath, edit };
})();
if (typeof module !== 'undefined') module.exports = TOCOutline;
