// A bounded display projection. Full, unmodified data remains in the archive.
export const DETAIL_MESSAGE_LIMIT = 100;
export const DETAIL_MESSAGE_BYTES = 64 * 1024;
export const DETAIL_PAGE_BYTES = 512 * 1024;

export function detailProjection(input, maxBytes = DETAIL_MESSAGE_BYTES) {
  let remaining = maxBytes, nodes = 0, truncated = false;
  const seen = new Set();
  function copy(value, depth = 0) {
    if (++nodes > 4096 || remaining <= 128 || depth > 8) { truncated = true; return '[显示内容已截断]'; }
    remaining -= 32;
    if (typeof value === 'string') {
      const limit = Math.min(16 * 1024, remaining - 64);
      let text = value.slice(0, limit);
      let cost = Buffer.byteLength(JSON.stringify(text));
      if (cost > limit) {
        let low = 0, high = text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= limit) low = mid; else high = mid - 1;
        }
        text = text.slice(0, low); cost = Buffer.byteLength(JSON.stringify(text));
      }
      if (text.length !== value.length) { truncated = true; text += '…（完整内容请下载档案）'; cost = Buffer.byteLength(JSON.stringify(text)); }
      remaining -= cost; return text;
    }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) { truncated = true; return '[Circular]'; }
    seen.add(value);
    const out = Array.isArray(value) ? [] : Object.create(null);
    let fields = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (++fields > 100 || remaining <= 128) { truncated = true; break; }
      const boundedKey = key.slice(0, 128); remaining -= Buffer.byteLength(JSON.stringify(boundedKey)) + 8;
      out[boundedKey] = copy(value[key], depth + 1);
    }
    seen.delete(value); return out;
  }
  const value = copy(input);
  return { value, truncated };
}

export function detailWindow(options = {}) {
  const offset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(options.offset) || 0)));
  const limit = Math.max(1, Math.min(DETAIL_MESSAGE_LIMIT, Math.floor(Number(options.limit) || DETAIL_MESSAGE_LIMIT)));
  return { offset, limit };
}

export function createDetailPage(options = {}) {
  const { offset, limit } = detailWindow(options);
  const messages = []; let count = 0, bytes = 0, truncated = false;
  return {
    onMessage(message) {
      const index = count++;
      if (index < offset || messages.length >= limit) return;
      // A byte-full page resumes at the first unreturned message, never skips it.
      if (index !== offset + messages.length) return;
      const projection = detailProjection(message);
      const cost = Buffer.byteLength(JSON.stringify(projection.value));
      if (messages.length && bytes + cost > DETAIL_PAGE_BYTES) return;
      messages.push(projection.value); bytes += cost; truncated ||= projection.truncated;
    },
    finish(metadata) {
      // Keep summary fields before bulky prompts/inputs, so truncation cannot
      // turn a UI array or usage object into a placeholder string.
      const ordered = Object.create(null);
      for (const key of ['id', 'chatKey', 'startedAt', 'endedAt', 'status', 'waitUntil', 'activity', 'triggerSummary', 'model', 'rounds', 'toolCalls', 'webSearchCount', 'usage', 'error', 'finishReason']) ordered[key] = metadata[key];
      for (const key in metadata) if (Object.hasOwn(metadata, key) && !Object.hasOwn(ordered, key)) ordered[key] = metadata[key];
      const projection = detailProjection(ordered, 256 * 1024);
      for (const key of ['sent', 'feedbacks', 'inputMessages']) if (!Array.isArray(projection.value[key])) projection.value[key] = [];
      return { ...projection.value, messages,
        detailPage: { offset, limit, returned: messages.length, total: count,
          nextOffset: offset + messages.length, hasMore: offset + messages.length < count,
          truncated: truncated || projection.truncated } };
    }
  };
}

export function activeSessionDetail(session, options = {}) {
  const page = createDetailPage(options);
  // Only a display window is projected; count may be large in a legacy live run.
  const all = session.messages || [];
  for (const message of all) page.onMessage(message);
  const metadata = Object.create(null);
  for (const key in session) if (key !== 'messages' && Object.hasOwn(session, key)) metadata[key] = session[key];
  return page.finish(metadata);
}
