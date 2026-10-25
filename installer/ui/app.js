/**
 * Koba chat — installer front-end.
 *
 * Single state-machine driving the conversation:
 *   greet → ask_email → ask_account → (login | signup)
 *                                      ↓
 *                                 wait_connect → offer_browser → done
 *
 * Every agent line renders as a bubble after a pacing delay so Koba doesn't
 * wall-of-text new users. User replies are collected via an input row or a
 * choice row, which we re-render per step.
 */

const chat = document.getElementById('chat');
const action = document.getElementById('action');
const stage = document.getElementById('stage');

const session = { email: '', user: null };

// ── Helpers ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pace = (text) => Math.min(1400, Math.max(450, text.length * 28));

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function addRow(kind, html) {
  const row = document.createElement('div');
  row.className = 'row ' + kind;
  row.innerHTML = `<div class="bubble">${html}</div>`;
  chat.appendChild(row);
  scrollToBottom();
  return row;
}

function addSpeaker(name) {
  // Label only once per streak of agent bubbles
  const last = chat.lastElementChild;
  if (last?.classList.contains('speaker') && last.textContent === name) return;
  if (last?.classList.contains('row') && last.classList.contains('agent')) return;
  const s = document.createElement('div');
  s.className = 'speaker';
  s.textContent = name;
  chat.appendChild(s);
}

function showTyping() {
  const row = document.createElement('div');
  row.className = 'row agent typing-row';
  row.innerHTML = `<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>`;
  chat.appendChild(row);
  scrollToBottom();
  return row;
}

async function koba(text) {
  addSpeaker('Koba');
  const typing = showTyping();
  await sleep(pace(text));
  typing.remove();
  addRow('agent', escapeHtml(text));
}

function me(text) {
  addRow('user', escapeHtml(text));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setAction(html) {
  action.innerHTML = html;
}

function clearAction() {
  action.innerHTML = '';
}

function setStage(label) {
  stage.textContent = label;
}

function askInput({ placeholder = '', type = 'text', submitLabel = 'Send' }) {
  return new Promise((resolve) => {
    setAction(`
      <div class="input-row">
        <input id="inp" type="${type}" placeholder="${escapeHtml(placeholder)}" autofocus />
        <button class="primary" id="btn">${escapeHtml(submitLabel)}</button>
      </div>
    `);
    const inp = document.getElementById('inp');
    const btn = document.getElementById('btn');
    const done = () => {
      const v = inp.value.trim();
      if (!v) return;
      clearAction();
      resolve(v);
    };
    btn.onclick = done;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    inp.focus();
  });
}

function askChoice(options) {
  return new Promise((resolve) => {
    const buttons = options
      .map((o, i) => `<button class="${o.primary ? 'primary' : 'secondary'}" data-i="${i}">${escapeHtml(o.label)}</button>`)
      .join('');
    setAction(`<div class="choices">${buttons}</div>`);
    action.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const opt = options[parseInt(b.dataset.i, 10)];
        clearAction();
        resolve(opt.value);
      };
    });
  });
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

// ── Flow ────────────────────────────────────────────────────────────────

async function run() {
  setStage('Greeting');
  await koba("Hey — I'm Koba. I'm going to get your team set up so Vincent and the rest of us can help you out directly from your machine.");
  await koba("It's quick. I just need your email, and if you don't have an Empir3 account yet, we'll make one together.");

  // Loop so the user can correct themselves
  let email = '';
  while (!email) {
    setStage('Email');
    const v = await askInput({ placeholder: 'you@domain.com', type: 'email', submitLabel: 'Next' });
    me(v);
    if (!v.includes('@')) {
      await koba("That doesn't look like an email — give me one with an @ in it?");
      continue;
    }
    email = v;
  }
  session.email = email;

  setStage('Account');
  const mode = await askChoice([
    { label: 'I already have one', value: 'login', primary: true },
    { label: 'Create one for me', value: 'signup' },
  ]);
  me(mode === 'login' ? 'I already have an Empir3 account' : 'Create one for me');

  if (mode === 'login') {
    await runLogin(email);
  } else {
    await runSignup(email);
  }

  // After auth, session.user is set and the Bridge gets launched.
  await runConnect();
  await runOpenBrowser();
  await runGoodbye();
}

async function runLogin(email) {
  while (true) {
    setStage('Password');
    await koba("What's your password?");
    const pwd = await askInput({ placeholder: 'password', type: 'password', submitLabel: 'Sign in' });
    me('••••••••');
    await koba("One second, signing you in…");
    const r = await api('/api/login', { email, password: pwd });
    if (r.ok) {
      session.user = r.user;
      await koba(`Welcome back, ${r.user?.name || email}.`);
      return;
    }
    await koba(`Hmm — ${r.error || 'that didn\'t work'}. Want to try again?`);
    const retry = await askChoice([
      { label: 'Try again', value: 'retry', primary: true },
      { label: "I don't have an account — make one", value: 'signup' },
    ]);
    me(retry === 'retry' ? 'Try again' : 'Make one for me');
    if (retry === 'signup') return runSignup(email);
  }
}

async function runSignup(email) {
  let name = '';
  while (!name) {
    setStage('Your name');
    await koba("Nice. What should I call you?");
    const v = await askInput({ placeholder: 'Your name', submitLabel: 'Next' });
    me(v);
    if (v.length > 100) { await koba("Let's keep it under 100 characters."); continue; }
    name = v;
  }

  while (true) {
    setStage('Password');
    await koba("Pick a password — eight characters minimum.");
    const pwd = await askInput({ placeholder: 'password (8+ chars)', type: 'password', submitLabel: 'Create account' });
    me('••••••••');
    if (pwd.length < 8) {
      await koba("Eight characters or more — that's the rule. Try again?");
      continue;
    }
    await koba("Got it. Creating your account…");
    const r = await api('/api/signup', { email, password: pwd, name });
    if (r.ok) {
      session.user = r.user;
      await koba(`You're in, ${r.user?.name || name}. Account created.`);
      return;
    }
    await koba(`That didn't work — ${r.error || 'something went wrong'}. Want to try a different password?`);
    const retry = await askChoice([
      { label: 'Try again', value: 'retry', primary: true },
      { label: 'I actually have an account', value: 'login' },
    ]);
    me(retry === 'retry' ? 'Try again' : 'I actually have one');
    if (retry === 'login') return runLogin(email);
  }
}

async function runConnect() {
  setStage('Connecting Bridge');
  await koba("Now I'm going to fire up the Bridge on your machine — that's the piece that lets the team reach you.");
  await api('/api/launch', {});

  // Poll bridge-status for up to 20s
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const r = await api('/api/bridge-status', {});
    if (r.connected) {
      await koba("Bridge is up and talking to the team.");
      return;
    }
    await sleep(800);
  }
  await koba("The Bridge is taking a bit longer than usual — it should connect on its own shortly. You can keep going.");
}

async function runOpenBrowser() {
  setStage('Open browser?');
  const choice = await askChoice([
    { label: 'Yes, open it and log me in', value: 'yes', primary: true },
    { label: 'Not now', value: 'no' },
  ]);
  me(choice === 'yes' ? 'Yes, open it' : 'Not right now');

  if (choice === 'yes') {
    await koba("On it. Opening Empir3 in your browser now.");
    await api('/api/open-browser', {});
  } else {
    await koba("No problem. You can open app.empir3.com whenever — you're already signed in.");
  }
}

async function runGoodbye() {
  setStage('Done');
  await koba("You're all set. The Bridge will stay running in the background. I'll close this window now.");
  await sleep(1200);
  await api('/api/close', {});
}

// ── Go ──────────────────────────────────────────────────────────────────

run().catch(async (e) => {
  await koba(`Something went wrong on my end: ${e.message}. You can close this window and try again.`);
});
