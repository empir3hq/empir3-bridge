import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Run the actual generated-page click handler without a daemon, credentials,
// or real navigation. Electron can intercept location.href and leave this page
// visible; that must leave a usable recovery path, not only "Opening empir3".
for (const file of ['server.ts', 'bridge.ts']) {
  for (const clipboardWorks of [true, false]) {
    test(`${file}: blocked navigation retains pairing URL; clipboard=${clipboardWorks}`, async () => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      const start = source.indexOf("$('pairEmpir3').addEventListener('click'");
      const end = source.indexOf("$('" + (file === 'server.ts' ? 'loginForm' : 'signOutBridge') + "').addEventListener", start);
      assert.ok(start > 0 && end > start);
      const nodes = new Map();
      function node() {
        return { children: [], style: {}, value: '', textContent: '', selected: false,
          appendChild(child) { this.children.push(child); return child; },
          setAttribute(k, v) { this[k] = v; },
          addEventListener(event, handler) { this[event] = handler; },
          select() { this.selected = true; },
        };
      }
      const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
      const url = 'https://app.empir3.com/connect-bridge?code=LOCAL-TEST';
      let navigated, copied;
      const location = {};
      Object.defineProperty(location, 'href', { set(value) { navigated = value; } });
      const reply = { ok: true, code: 'LOCAL-TEST', redirectUrl: url };
      vm.runInNewContext(source.slice(start, end), {
        $: get, API: '', selectedServer: () => 'https://app.empir3.com',
        postJson: async () => reply, fetch: async () => ({ json: async () => reply }),
        setStatus: (id, text) => { get(id).textContent = text; get(id).children = []; },
        document: { createElement: node }, location, setTimeout: fn => fn(),
        navigator: { clipboard: { writeText: async value => {
          if (!clipboardWorks) throw new Error('Clipboard denied');
          copied = value;
        } } },
      });
      await get('pairEmpir3').click();
      assert.equal(navigated, url);
      const status = get(file === 'server.ts' ? 'drawerStatus' : 'pairStatus');
      const input = status.children.find(child => child.value === url);
      assert.ok(input, 'a selectable fallback URL must survive intercepted navigation');
      assert.equal(input.readOnly, true);
      assert.match(input['aria-label'], /pairing/i);
      const copy = status.children.find(child => child.textContent === 'Copy pairing link');
      assert.ok(copy, 'a manual copy action must remain available');
      await copy.click();
      if (clipboardWorks) assert.equal(copied, url);
      else assert.equal(input.selected, true, 'denied clipboard selects the link for manual copying');
    });
  }
}
