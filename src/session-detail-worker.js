import { workerData, parentPort } from 'node:worker_threads';
import { readJsonObjectArray } from './storage-json-stream.js';
import { createDetailPage } from './session-detail.js';

try {
  const page = createDetailPage(workerData);
  const { metadata } = await readJsonObjectArray(workerData.file, {
    onMessage: message => page.onMessage(message), maxRecordBytes: 4 * 1024 * 1024
  });
  parentPort.postMessage({ value: page.finish(metadata) });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error), status: /字节上限/.test(error?.message || '') ? 413 : 422 });
}
