'use strict';

function nestedMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return nestedMessage(parsed) || trimmed;
      } catch {}
    }
    return trimmed;
  }
  if (typeof value !== 'object') return String(value);
  return nestedMessage(value.error) || nestedMessage(value.message) || '';
}

function parseCodexJsonl(stdout) {
  let text = '';
  let failure = '';
  let eventCount = 0;
  let turnFailed = false;

  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    eventCount += 1;

    const candidate =
      (event?.item?.type === 'agent_message' ? (event.item.text || event.item.message) : '')
      || (event?.msg?.type === 'agent_message' ? (event.msg.message || event.msg.text) : '')
      || (event?.type === 'agent_message' ? (event.text || event.message) : '')
      || event?.agent_message
      || '';
    if (typeof candidate === 'string' && candidate.trim()) text = candidate.trim();

    if (event?.type === 'turn.failed') {
      turnFailed = true;
      failure = nestedMessage(event.error) || failure || 'Codex turn failed';
    } else if (event?.type === 'error') {
      failure = nestedMessage(event) || failure;
    }
  }

  return {
    text,
    eventCount,
    failed: turnFailed,
    failure,
  };
}

module.exports = { parseCodexJsonl };
