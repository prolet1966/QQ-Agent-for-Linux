// kb-schema.js —— 四个集合 + 索引（从宿主 kb-schema.js 照搬）
export const COLLECTIONS = {
  chunks: 'knowledge_chunks',
  candidates: 'knowledge_candidates',
  tasks: 'ingest_tasks',
  logs: 'agent_logs',
};
export const STATUS = {
  pending: 'pending',
  auto_approved: 'auto_approved',
  duplicate: 'duplicate',
  rejected: 'rejected',
  active: 'active',
  revoked: 'revoked',
};
export const INIT_INDEXES = [
  { collection: COLLECTIONS.chunks, keys: { tenant_id: 1, doc_id: 1, status: 1 }, name: 'tenant_doc_status' },
  { collection: COLLECTIONS.chunks, keys: { tenant_id: 1, tokens: 1 }, name: 'tenant_tokens', sparse: true },
  { collection: COLLECTIONS.chunks, keys: { content_hash: 1 }, name: 'content_hash_unique', unique: true, sparse: true },
  { collection: COLLECTIONS.chunks, keys: { expires_at: 1 }, name: 'chunks_ttl', expireAfterSeconds: 0 },
  { collection: COLLECTIONS.candidates, keys: { tenant_id: 1, status: 1 }, name: 'cand_tenant_status' },
  { collection: COLLECTIONS.candidates, keys: { url_hash: 1 }, name: 'cand_url_hash', sparse: true },
  { collection: COLLECTIONS.candidates, keys: { doc_content_hash: 1 }, name: 'cand_doc_content_hash', sparse: true },
  { collection: COLLECTIONS.candidates, keys: { expires_at: 1 }, name: 'cand_ttl', expireAfterSeconds: 0 },
  { collection: COLLECTIONS.tasks, keys: { status: 1, priority: -1, created_at: 1 }, name: 'task_queue' },
  { collection: COLLECTIONS.tasks, keys: { leased_until: 1 }, name: 'task_lease', sparse: true },
  { collection: COLLECTIONS.tasks, keys: { expires_at: 1 }, name: 'task_ttl', expireAfterSeconds: 0 },
  { collection: COLLECTIONS.logs, keys: { tenant_id: 1, event: 1, created_at: -1 }, name: 'log_query' },
  { collection: COLLECTIONS.logs, keys: { expires_at: 1 }, name: 'log_ttl', expireAfterSeconds: 0 },
];
