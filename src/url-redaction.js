export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    for (const key of [...url.searchParams.keys()]) if (/key|token|password|secret|credential/i.test(key)) url.searchParams.set(key, 'REDACTED');
    return url.href;
  } catch { return String(raw || '').replace(/([?&](?:token|access_token|api_key|password)=)[^&\s]+/gi, '$1REDACTED'); }
}
