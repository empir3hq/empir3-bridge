import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateNetworkAddress, validateBrowserNavigationUrl } from '../src/browser-navigation-policy.mjs';

test('browser navigation permits public http(s) and the Bridge control page', () => {
  assert.equal(validateBrowserNavigationUrl('https://example.com/path').ok, true);
  assert.equal(validateBrowserNavigationUrl('http://localhost:3006/', { allowedLocalPorts: [3006] }).ok, true);
  assert.equal(validateBrowserNavigationUrl('about:blank').ok, true);
});

test('browser navigation blocks active-content, file, credential, and private-network URLs', () => {
  for (const url of [
    'file:///C:/Users/test/.ssh/id_rsa',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'http://user:pass@example.com/',
    'http://127.0.0.1:8080/admin',
    'http://10.2.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://[::1]:8080/',
    'http://printer.localhost/',
  ]) {
    assert.equal(validateBrowserNavigationUrl(url, { allowedLocalPorts: [3006] }).ok, false, url);
  }
});
test('private and special-use literal addresses are recognized', () => {
  for (const address of ['0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.31.0.1', '192.168.2.2', '224.0.0.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateNetworkAddress(address), true, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPrivateNetworkAddress(address), false, address);
  }
});
