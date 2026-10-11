#!/usr/bin/env python3
# KERF smoke test: serves dist/, opens the app in headless Chromium and drives every workspace.
# Usage: npm test   (or: python3 scripts/smoke_test.py after `npm run build`)
# Needs: pip install playwright && playwright install chromium
# SPDX-License-Identifier: AGPL-3.0-or-later
import asyncio, os, re, socket, subprocess, sys, tempfile, time, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(tempfile.mkdtemp(prefix='kerf-smoke-'))
failures = []

def check(ok, label, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + label + (f'  ({detail})' if detail else ''))
    if not ok: failures.append(label)

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]

async def palette(pg, text):
    await pg.keyboard.press('Control+k'); await pg.wait_for_timeout(200)
    await pg.keyboard.type(text); await pg.wait_for_timeout(200)
    await pg.keyboard.press('Enter'); await pg.wait_for_timeout(300)

async def download(pg, action, name, timeout=60000):
    async with pg.expect_download(timeout=timeout) as dl:
        await action()
    d = await dl.value; path = OUT / name; await d.save_as(path); return path

def mass(status):
    m = re.search(r'([\d.]+) g', status or ''); return float(m.group(1)) if m else None

async def run(url):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
        pg = await ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(f'{e} @ {(e.stack or "").splitlines()[1:3]}'))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

        print('Boot')
        await pg.goto(url); await pg.wait_for_timeout(6000)
        check(await pg.locator('.tabs').count() == 1, 'app shell renders')
        pages = await pg.locator('.lay-pagewrap').count()
        check(pages == 4, 'sample document has 4 layout pages', str(pages))

        print('Layout')
        pre = await pg.evaluate("[...document.querySelectorAll('.pane')].find(p=>p.querySelector('h3')?.textContent.startsWith('Preflight'))?.innerText || ''")
        check('CLEAN' in pre.upper(), 'preflight is clean', pre.replace('\n', ' ')[:80])
        await palette(pg, 'export layout as pdf')
        pdf = await download(pg, lambda: pg.click('.dialog .btn.primary'), 'out.pdf')
        data = pdf.read_bytes()
        npages = len(re.findall(rb'/Type\s*/Page(?!s)', data))
        check(data.startswith(b'%PDF-') and npages == 4, 'PDF export: 4 pages', f'{len(data)} bytes, {npages} pages')
        check(b'/TrimBox' in data and b'/BleedBox' in data, 'PDF has trim and bleed boxes')
        fonts = len(re.findall(rb'/FontFile[23]', data))
        check(fonts >= 3 and b'/ToUnicode' in data, 'PDF embeds subset fonts with searchable text', f'{fonts} font files')

        print('Vector')
        await pg.click('#tab-vector'); await pg.wait_for_timeout(800)
        await pg.keyboard.press('m')
        await pg.mouse.move(520, 200); await pg.mouse.down(); await pg.mouse.move(700, 330, steps=8); await pg.mouse.up()
        await pg.wait_for_timeout(300); await pg.keyboard.press('v')
        await pg.keyboard.down('Shift'); await pg.mouse.click(530, 170); await pg.keyboard.up('Shift')
        await pg.wait_for_timeout(300)
        n = await pg.evaluate("document.querySelectorAll('.vec-svg .sel-outline').length")
        check(n == 2, 'shift-click adds to selection', str(n))
        await palette(pg, 'pathfinder unite'); await pg.wait_for_timeout(500)
        n = await pg.evaluate("document.querySelectorAll('.vec-svg .sel-outline').length")
        check(n == 1, 'boolean unite merges two shapes into one', str(n))
        svg = await download(pg, lambda: palette(pg, 'export artboard as svg'), 'out.svg')
        check('<svg' in svg.read_text(), 'SVG export', f'{svg.stat().st_size} bytes')
        await palette(pg, 'export as dxf')
        dxf = await download(pg, lambda: pg.click('.dialog .btn.primary'), 'out.dxf')
        t = dxf.read_text()
        check('ENTITIES' in t and '$INSUNITS' in t, 'DXF export for laser / CNC', f'{dxf.stat().st_size} bytes')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(300)

        print('CAD')
        await pg.click('#tab-cad')
        status = ''
        for _ in range(40):  # wait for the precise kernel
            await pg.wait_for_timeout(500)
            status = await pg.evaluate("document.querySelector('.status .left').textContent")
            if 'Precise' in status: break
        check('Precise' in status, 'OpenCascade kernel loads', status)
        m0 = mass(status)
        inp = pg.locator('input[aria-label="Value of #w"]')
        await inp.fill('80 mm'); await inp.press('Enter'); await pg.wait_for_timeout(2500)
        status = await pg.evaluate("document.querySelector('.status .left').textContent"); m1 = mass(status)
        check(m0 and m1 and m1 > m0, 'changing #w rebuilds the part and its mass', f'{m0} g → {m1} g')
        step = await download(pg, lambda: palette(pg, 'export part as step'), 'part.step')
        check(step.read_bytes().startswith(b'ISO-10303-21'), 'STEP export', f'{step.stat().st_size} bytes')
        stl = await download(pg, lambda: palette(pg, 'export part as stl'), 'part.stl')
        check(stl.stat().st_size > 84, 'STL export', f'{stl.stat().st_size} bytes')
        await pg.click('.seg button:has-text("Heavy")'); await pg.wait_for_timeout(2500)
        m2 = mass(await pg.evaluate("document.querySelector('.status .left').textContent"))
        check(m2 and m1 and m2 > m1, 'Heavy configuration is heavier', f'{m2} g')
        await pg.click('.seg button:has-text("Default")'); await pg.wait_for_timeout(2000)
        await palette(pg, 'add extrude feature'); await pg.wait_for_timeout(3000)
        hint = await pg.evaluate("[...document.querySelectorAll('.pane .hint')].map(e => e.textContent).join(' | ')")
        check('Fully defined' in hint, 'new extrude gets a solved, fully defined sketch (PlaneGCS)', hint[:60])
        await pg.click('button:has-text("Edit sketch")'); await pg.wait_for_timeout(1500)
        dof = await pg.evaluate("document.querySelector('.sk-dof b')?.textContent")
        await pg.keyboard.press('c'); box = await pg.locator('.sk-canvas').bounding_box()
        await pg.mouse.click(box['x'] + box['width'] * .5, box['y'] + box['height'] * .5); await pg.mouse.click(box['x'] + box['width'] * .56, box['y'] + box['height'] * .5)
        await pg.wait_for_timeout(500); dof2 = await pg.evaluate("document.querySelector('.sk-dof b')?.textContent")
        check(dof == '0' and dof2 == '3', 'sketcher: circle adds 3 degrees of freedom', f'{dof} → {dof2}')
        await pg.click('.sketcher button:has-text("Done")'); await pg.wait_for_timeout(2500)
        async with pg.expect_file_chooser() as fc:
            await palette(pg, 'import step part')
        await (await fc.value).set_files(str(step)); await pg.wait_for_timeout(5000)
        hint = await pg.evaluate("[...document.querySelectorAll('.pane .hint')].map(e => e.textContent).join(' | ')")
        check('read by OpenCascade' in hint, 'STEP import', hint[:50])

        print('Mesh')
        await pg.click('#tab-mesh'); await pg.wait_for_timeout(1500)
        glb = await download(pg, lambda: palette(pg, 'export scene as glb'), 'scene.glb')
        check(glb.read_bytes()[:4] == b'glTF', 'GLB export', f'{glb.stat().st_size} bytes')
        before = await pg.evaluate("document.querySelector('.status .left').textContent")
        async with pg.expect_file_chooser() as fc:
            await palette(pg, 'import glb stl obj rhino')
        await (await fc.value).set_files(str(ROOT / 'scripts' / 'fixtures' / 'block-and-sphere.3dm')); await pg.wait_for_timeout(5000)
        await pg.click('#tab-layout'); await pg.wait_for_timeout(500); await pg.click('#tab-mesh'); await pg.wait_for_timeout(2500)
        after = await pg.evaluate("document.querySelector('.status .left').textContent")
        check(after != before and 'objects' in after, 'Rhino .3dm import', after[:40])
        await palette(pg, 'add box'); await palette(pg, 'add sphere')
        items = pg.locator('.pane .list.tall .li:visible')
        await items.nth(0).click(); await items.nth(1).click(modifiers=['Shift']); await pg.wait_for_timeout(300)
        await palette(pg, 'boolean subtract'); await pg.wait_for_timeout(4000)
        eng = await pg.evaluate("[...document.querySelectorAll('.pane')].map(p => p.textContent).find(t => t.includes('Boolean engine')) || ''")
        check('Manifold' in eng and 'watertight' in eng, 'Manifold boolean', eng[14:70])

        print('Pledge and source')
        await palette(pg, 'show the kerf pledge'); await pg.wait_for_timeout(300)
        src = await download(pg, lambda: pg.click('.dialog button:has-text("Get the source")'), 'source.zip')
        names = zipfile.ZipFile(src).namelist()
        check(any(n.endswith('/LICENSE') for n in names) and any(n.endswith('src/main.js') for n in names), 'source archive downloads from the app', f'{len(names)} files')
        await pg.click('.dialog button:has-text("Licences")'); await pg.wait_for_timeout(300)
        notices = await pg.evaluate("document.querySelector('.notices')?.textContent || ''")
        check('three' in notices and 'Open Font License' in notices, 'third-party licences are shown')

        print('Phone width')
        m = await b.new_page(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        m.on('pageerror', lambda e: errors.append(str(e)))
        await m.goto(url); await m.wait_for_timeout(4000)
        sw = await m.evaluate("Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)")
        check(sw <= 390, 'no horizontal scroll at 390 px', str(sw))

        check(not errors, 'no page errors', '; '.join(errors[:3]))
        await b.close()

def main():
    dist = ROOT / 'dist'
    if not (dist / 'index.html').exists():
        print('dist/ is missing. Run `npm run build` first.'); sys.exit(2)
    try:
        import playwright  # noqa: F401
    except ImportError:
        print('Playwright is missing: pip install playwright && playwright install chromium'); sys.exit(2)
    port = free_port()
    srv = subprocess.Popen(['node', str(ROOT / 'scripts' / 'serve.mjs'), str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(50):
            try: socket.create_connection(('127.0.0.1', port), 0.2).close(); break
            except OSError: time.sleep(0.1)
        asyncio.run(run(f'http://127.0.0.1:{port}/index.html'))
    finally:
        srv.terminate()
    print(f'\n{"PASS" if not failures else "FAIL"} · outputs in {OUT}')
    if failures: print('Failed: ' + ', '.join(failures)); sys.exit(1)

if __name__ == '__main__':
    main()
