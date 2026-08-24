#!/usr/bin/env python3
"""
Stamps every local script/style reference with a fresh ?v=<timestamp> so a
normal page reload always fetches the latest deployed code instead of a
browser-cached copy. Run this before every git push that touches js/ or css/.

Versions every reference to the SAME file identically across all files, so
modules that are imported by more than one file (e.g. app.js) still resolve
to a single shared module instance in the browser - singleton state (ctx,
current tab, etc.) stays intact.
"""
import re, time, pathlib

ROOT = pathlib.Path(__file__).parent
VERSION = str(int(time.time()))

# .js local imports: from "./name.js" or "./name.js?v=OLD"
IMPORT_RE = re.compile(r'(from\s+"\.\/([\w-]+)\.js)(?:\?v=\d+)?(")')
# index.html script tag: src="js/name.js" or "...?v=OLD"
SCRIPT_RE = re.compile(r'(src="js\/([\w-]+)\.js)(?:\?v=\d+)?(")')
# index.html stylesheet: href="css/style.css" or "...?v=OLD"
STYLE_RE = re.compile(r'(href="css\/style\.css)(?:\?v=\d+)?(")')

targets = list(ROOT.glob("js/*.js")) + [ROOT / "index.html"]
changed = 0
for path in targets:
    text = path.read_text()
    new = IMPORT_RE.sub(lambda m: f'{m.group(1)}?v={VERSION}{m.group(3)}', text)
    new = SCRIPT_RE.sub(lambda m: f'{m.group(1)}?v={VERSION}{m.group(3)}', new)
    new = STYLE_RE.sub(lambda m: f'{m.group(1)}?v={VERSION}{m.group(2)}', new)
    if new != text:
        path.write_text(new)
        changed += 1

print(f"Stamped version {VERSION} across {changed} file(s).")
