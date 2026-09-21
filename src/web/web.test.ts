/**
 * The UI has no build step, so nothing else would catch a syntax error in it
 * until the page silently rendered blank in the browser. This is that check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('app.js parses as an ES module', () => {
  const source = readFileSync(path.join(here, 'app.js'), 'utf8');
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    assert.fail(`app.js has a syntax error:\n${detail}`);
  }
});

test('index.html references the stylesheet and the module', () => {
  const html = readFileSync(path.join(here, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test('every nav button in the HTML has a matching view in app.js', () => {
  const html = readFileSync(path.join(here, 'index.html'), 'utf8');
  const js = readFileSync(path.join(here, 'app.js'), 'utf8');

  const navViews = [...html.matchAll(/data-view="([\w-]+)"/g)].map((m) => m[1]!);
  assert.ok(navViews.length > 0, 'expected nav buttons in index.html');

  const viewsBlock = /const VIEWS = \{([\s\S]*?)\};/.exec(js);
  assert.ok(viewsBlock, 'could not find the VIEWS map in app.js');

  for (const name of navViews) {
    assert.match(viewsBlock[1]!, new RegExp(`\\b${name}\\s*:`),
      `nav button "${name}" has no entry in VIEWS — clicking it would throw`);
  }
});

test('elements the app looks up by id exist in the HTML', () => {
  const html = readFileSync(path.join(here, 'index.html'), 'utf8');
  const js = readFileSync(path.join(here, 'app.js'), 'utf8');

  // Ids the app creates itself at render time; only static ones must be present.
  const dynamic = new Set(['job-console', 'job-status']);
  const ids = new Set([...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]!));

  for (const id of ids) {
    if (dynamic.has(id)) continue;
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing from index.html`);
  }
});
