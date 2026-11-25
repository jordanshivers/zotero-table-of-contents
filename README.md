# Zotero Table of Contents

Build and edit a PDF's table of contents in Zotero. 

## Install

Download the `.xpi` from the [latest release](../../releases/latest).

## Use

In the contents sidebar:

- **+ Add entry for this page** adds an entry for the page you are reading.
- Right-click an entry to rename it, point it to the current page, add an entry below or inside it, move it, nest it, or delete it.
- To change several entries at once, Cmd-click (Ctrl-click on Windows and Linux) to pick them one by one, or click one and Shift-click another to pick everything between. Then right-click any of them to move, nest, or delete them together.

In the PDF itself:

- Select some text, such as a chapter heading, right-click it, and choose **Add outline item** to add an entry with that title pointing at that spot.

If a PDF has no table of contents of its own, Zotero shows headings it detected. These aren't stored in the PDF. Right-click the list and choose **Save detected headings to PDF** to keep and edit them; you are also asked about this the first time you add or change an entry.

Encrypted, signed, and read-only PDFs are refused.

## Develop

Run the tests with `node --test tests/*.test.cjs` and build the `.xpi` with `python3 build.py`, which also writes `updates.json`.

To release: set the version in `src/manifest.json`, run `python3 build.py`, commit (including `updates.json`), push, then push a tag named `v<version>`. GitHub Actions tests, builds, and attaches the `.xpi` to the release. See
[CHANGELOG.md](CHANGELOG.md).
