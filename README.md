# Zotero Table of Contents

Build and edit a PDF's table of contents in Zotero. 

Zotero 10.0.x only. 

## Install

Download the `.xpi` from the [latest release](../../releases/latest).

## Use

In the contents sidebar:

- **+ Add entry for this page** adds an entry for the page you are reading.
- Right-click an entry to rename it, point it to the current page, add an entry below or inside it, move it, nest it, or delete it.

Encrypted, signed, and read-only PDFs are refused.

## Develop

Run the tests with `node --test tests/*.test.cjs` and build the `.xpi` with `python3 build.py`. See [CHANGELOG.md](CHANGELOG.md).

[MIT license](LICENSE). Bundles [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT).
