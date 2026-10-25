export function safeConversationId(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > 128 || value.includes('..')) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

export function safeFlatResourceName(raw, { extensions = [], appendExtension = '' } = {}) {
  let value;
  try { value = decodeURIComponent(String(raw || '')).trim(); }
  catch { return null; }
  if (!value || value.length > 180 || value.includes('..') || /[\\/\0]/.test(value)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(value)) return null;
  if (appendExtension && !value.toLowerCase().endsWith(appendExtension.toLowerCase())) value += appendExtension;
  if (extensions.length && !extensions.some(ext => value.toLowerCase().endsWith(ext.toLowerCase()))) return null;
  return value;
}
