"""Build the installable XPI with Python's standard library."""
from pathlib import Path
import json
import zipfile
from urllib.parse import urlparse

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'src/manifest.json').read_text())
version = manifest['version']
for field in ('id', 'update_url', 'strict_max_version'):
    if not manifest.get('applications', {}).get('zotero', {}).get(field):
        raise ValueError(f'Missing applications.zotero.{field}')
update_url = urlparse(manifest['applications']['zotero']['update_url'])
if update_url.scheme != 'https' or not update_url.hostname:
    raise ValueError('Zotero requires an HTTPS update_url')
dest = root / f'dist/zotero-toc-{version}.xpi'
dest.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
    for file in sorted((root / 'src').rglob('*')):
        if file.is_file() and not any(part.startswith('.') for part in file.relative_to(root / 'src').parts):
            z.write(file, file.relative_to(root / 'src'))
print(dest)
