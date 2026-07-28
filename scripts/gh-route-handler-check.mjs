// Focused live check for the lent-GitHub-CLI execution + enforcement layer that
// the new empir3-channel route (handleEmpir3Message: github:probe / github:exec)
// delegates to. Exercises the REAL handlers against REAL gh on this machine.
// Read-only gh commands only. Run: npx tsx scripts/gh-route-handler-check.mjs
import * as ghNs from '../src/handlers/github-cli.ts';
const gh = ghNs.default ?? ghNs;
const { probeGithubCli, githubExec, defaultGhScopes } = gh;

const ON = defaultGhScopes();                       // read/pr/issue/repo/release on; workflow/admin/api_write off
let pass = 0, fail = 0;
const ok = (c, msg, extra) => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}${extra ? `  → ${extra}` : ''}`); };

console.log('— probe —');
const p = await probeGithubCli(true, ON);
ok(p.available === true, 'probe: gh available', `path=${p.path}`);
ok(p.authenticated === true, 'probe: authenticated', `account=${p.account}`);
ok(typeof p.account === 'string' && p.account.length > 0, 'probe: active account parsed', p.account);
ok(p.device_opted_in === true && !!p.scopes, 'probe: opt-in + scope matrix surfaced', JSON.stringify(p.scopes));

console.log('\n— exec: read-scope commands (real gh) —');
const ver = await githubExec({ args: ['--version'], scopes: ON });
ok(ver.success === true && /gh version/i.test(ver.stdout || ''), 'exec gh --version', (ver.stdout || '').split('\n')[0]);
ok(ver.scope === 'read' && ver.exitCode === 0, 'exec --version classified read, exit 0');

const auth = await githubExec({ args: ['auth', 'status'], scopes: ON });
ok(auth.success === true && auth.scope === 'read', 'exec gh auth status (read)', `exit ${auth.exitCode}`);

const repos = await githubExec({ args: ['repo', 'list', '--limit', '3'], scopes: ON });
ok(repos.success === true && repos.scope === 'read', 'exec gh repo list --limit 3 (real API call)', `exit ${repos.exitCode}`);
console.log('   repo list head:', (repos.stdout || repos.stderr || '').split('\n').slice(0, 3).join(' | ').slice(0, 160));

console.log('\n— enforcement: scope gate + hard-blocks —');
const secret = await githubExec({ args: ['secret', 'list'], scopes: ON }); // admin scope, default OFF
ok(secret.success === false && secret.stage === 'scope_disabled' && secret.scope === 'admin',
   'exec gh secret list refused (scope_disabled: admin)', `stage=${secret.stage} scope=${secret.scope}`);

const wf = await githubExec({ args: ['workflow', 'run', 'ci.yml'], scopes: ON }); // workflow scope, default OFF
ok(wf.success === false && wf.stage === 'scope_disabled' && wf.scope === 'workflow',
   'exec gh workflow run refused (scope_disabled: workflow)', `scope=${wf.scope}`);

const tok = await githubExec({ args: ['auth', 'token'], scopes: ON });
ok(tok.success === false && tok.stage === 'blocked', 'exec gh auth token HARD-BLOCKED', tok.error?.slice(0, 60));

const ext = await githubExec({ args: ['extension', 'install', 'x/y'], scopes: ON });
ok(ext.success === false && ext.stage === 'blocked', 'exec gh extension install HARD-BLOCKED');

const bogus = await githubExec({ args: ['frobnicate'], scopes: ON });
ok(bogus.success === false && bogus.stage === 'blocked', 'exec unknown top-level cmd default-DENY');

console.log('\n— scope-enabled passes when toggled on —');
const adminOn = { ...ON, admin: true };
const secret2 = await githubExec({ args: ['secret', 'list', '--repo', `${p.account}/nonexistent-repo-xyz`], scopes: adminOn });
// With admin enabled the scope gate passes; gh itself may cli_error on a bogus repo — that's the right layer.
ok(secret2.stage !== 'scope_disabled', 'admin scope enabled → passes scope gate (reaches gh)', `stage=${secret2.stage ?? 'ok'}`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
