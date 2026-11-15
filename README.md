# Zotero TOC

Build and edit a PDF's table of contents from Zotero's contents sidebar.

Experimental. Zotero 10.0.x only. 

## Install

Download the `.xpi` from the [latest release](../../releases/latest).

## Use

In the contents sidebar:

- **+ Add entry for this page** adds an entry for the page you are reading.
- Right-click an entry to rename it, point it to the current page, add an entry below or inside it, move it, nest it, or delete it.

Encrypted, signed, and read-only PDFs are refused.

## Backups

Each edit first copies the PDF to `zotero-toc-backups/<libraryID>-<attachmentKey>/` in your Zotero data directory: `original.pdf` (before the first edit) and `previous.pdf` (before the latest). To restore, replace the attachment's file with one of them.

## Develop

Run the tests with `node --test tests/*.test.cjs` and build the `.xpi` with `python3 build.py`. See [CHANGELOG.md](CHANGELOG.md).

[MIT license](LICENSE). Bundles [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT).
