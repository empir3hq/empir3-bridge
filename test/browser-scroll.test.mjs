import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { browserScrollExpression } from '../src/browser-scroll.ts';

function element(options = {}) {
  return {
    nodeType: 1,
    parentElement: options.parentElement || null,
    scrollTop: options.scrollTop || 0,
    scrollLeft: options.scrollLeft || 0,
    scrollHeight: options.scrollHeight || 0,
    scrollWidth: options.scrollWidth || 0,
    clientHeight: options.clientHeight || 0,
    clientWidth: options.clientWidth || 0,
    computedStyle: {
      overflowY: options.overflowY || 'visible',
      overflowX: options.overflowX || 'visible',
    },
  };
}

function run(expression, target, root) {
  const documentElement = root;
  const document = {
    scrollingElement: root,
    documentElement,
    body: root,
    elementFromPoint: () => target,
  };
  const raw = vm.runInNewContext(expression, {
    document,
    window: { innerWidth: root.clientWidth, innerHeight: root.clientHeight },
    getComputedStyle: node => node.computedStyle,
  });
  return JSON.parse(raw);
}

test('overflow-hidden hero residual is skipped and the document consumes the wheel', () => {
  const root = element({ scrollHeight: 3_000, clientHeight: 700, clientWidth: 1_200 });
  const hero = element({ parentElement: root, overflowY: 'hidden', scrollHeight: 720, clientHeight: 700 });
  const receipt = run(browserScrollExpression(0, 600), hero, root);
  assert.equal(hero.scrollTop, 0);
  assert.equal(root.scrollTop, 600);
  assert.deepEqual(receipt.movedTargets, ['window']);
  assert.equal(receipt.remaining.y, 0);
});

test('nested scroller consumes what it can and chains the residual to the document', () => {
  const root = element({ scrollTop: 200, scrollHeight: 3_000, clientHeight: 700, clientWidth: 1_200 });
  const panel = element({ parentElement: root, overflowY: 'auto', scrollTop: 95, scrollHeight: 200, clientHeight: 100 });
  const child = element({ parentElement: panel });
  const receipt = run(browserScrollExpression(0, 60), child, root);
  assert.equal(panel.scrollTop, 100);
  assert.equal(root.scrollTop, 255);
  assert.deepEqual(receipt.movedTargets, ['inner', 'window']);
  assert.equal(receipt.delta.y, 60);
  assert.equal(receipt.remaining.y, 0);
});
