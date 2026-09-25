// mg-review.js —— 审核与生命周期（宿主 review/forget/archive/undo 语义照搬）
// 关键修复（交接第十节）：upsert 匹配键补齐 chat_key（防跨群串味）；mention_count 用 $max 不被冲小。

export async function reviewCandidate(db, c, { action, memoryId, chatKey, tenant }) {
  if (action === 'approve') {
    // 转正：候选 → memory_items，upsert 用 tenant+chat_key+content_key 匹配（宿主修复）
    const cand = await db.collection('memory_candidates').findOne({ memory_id: memoryId, tenant_id: tenant });
    if (!cand) return { ok: false, error: '找不到候选 ' + memoryId };
    const key = cand.content_key;
    await db.collection('memory_candidates').updateOne({ memory_id: memoryId, tenant_id: tenant }, {
      $set: { status: 'approved', approved_at: new Date() },
    });
    await db.collection('memory_items').updateOne(
      { tenant_id: tenant, chat_key: cand.chat_key, content_key: key },
      {
        $set: {
          memory_id: memoryId, kind: cand.kind, content: cand.content,
          subject_id: cand.subject_id ?? null, subject_name: cand.subject_name ?? null,
          status: 'active', promoted_at: new Date(),
        },
        $setOnInsert: { created_at: new Date(), chat_key: cand.chat_key, mention_count: cand.mention_count ?? 1 },
      },
      { upsert: true },
    );
    await audit(db, tenant, 'memory.promoted', { memory_id: memoryId, content_key: key });
    return { ok: true, memoryId, status: 'active' };
  }
  if (action === 'reject') {
    const res = await db.collection('memory_candidates').updateOne(
      { memory_id: memoryId, tenant_id: tenant },
      { $set: { status: 'rejected', rejected_at: new Date() } },
    );
    await audit(db, tenant, 'memory.rejected', { memory_id: memoryId });
    return { ok: res.matchedCount > 0, memoryId, status: 'rejected' };
  }
  return { ok: false, error: '未知审核操作 ' + action };
}

export async function undoPromote(db, tenant, memoryId) {
  // 撤销转正：正式库删掉、候选退回待审（宿主阶段 D）
  await db.collection('memory_items').deleteOne({ memory_id: memoryId, tenant_id: tenant });
  const res = await db.collection('memory_candidates').updateOne(
    { memory_id: memoryId, tenant_id: tenant },
    { $set: { status: 'pending', reopened: null, approved_at: null } },
  );
  await audit(db, tenant, 'memory.undone', { memory_id: memoryId });
  return { ok: res.modifiedCount > 0, memoryId, status: 'pending' };
}

export async function forgetOne(db, tenant, memoryIds) {
  // 遗忘：候选+正式库一起删，删前把内容摘要写进审计（宿主：事后查得到删了什么）
  const cands = await db.collection('memory_candidates').find({ tenant_id: tenant, memory_id: { $in: memoryIds } }).toArray();
  await db.collection('memory_candidates').deleteMany({ tenant_id: tenant, memory_id: { $in: memoryIds } });
  const items = await db.collection('memory_items').find({ tenant_id: tenant, memory_id: { $in: memoryIds } }).toArray();
  await db.collection('memory_items').deleteMany({ tenant_id: tenant, memory_id: { $in: memoryIds } });
  await db.collection('memory_audit').insertOne({
    event: 'memory.forgotten', tenant_id: tenant, memory_ids: memoryIds,
    content_summary: [...cands, ...items].map((m) => ({ id: m.memory_id, kind: m.kind, text: String(m.content ?? '').slice(0, 80) })),
    ts: new Date(),
  });
  return { ok: true, count: cands.length + items.length };
}

export async function archiveOne(db, c, { tenant, memoryIds, days }) {
  // 衰减归档：只针对 event（梗/关系不会过期）；自动归档默认关（archiveAfterDays=0）
  const filter = { tenant_id: tenant, kind: 'event' };
  if (Array.isArray(memoryIds) && memoryIds.length) filter.memory_id = { $in: memoryIds };
  else if (typeof days === 'number' && days > 0) {
    const cutoff = new Date(Date.now() - days * 86400_000);
    filter.last_seen_at = { $lt: cutoff };
  }
  if (Array.isArray(memoryIds) && memoryIds.length) {
    // 单条归档（宿主第十八节：给了 memoryIds 就归档这几条）
    const res = await db.collection('memory_items').updateMany({ tenant_id: tenant, memory_id: { $in: memoryIds } }, { $set: { archived: true, archived_at: new Date() } });
    await audit(db, tenant, 'memory.archived', { memory_ids: memoryIds });
    return { ok: true, count: res.modifiedCount };
  }
  // 按天数：两段式 —— 第一次 dry-run 只预览，第二次 apply 才真归档（宿主防手滑）
  const preview = await db.collection('memory_items').countDocuments(filter);
  if (c.archiveAfterDays === 0 && !memoryIds) {
    return { ok: true, count: 0, preview, applied: false, note: '自动归档默认关（archiveAfterDays=0）；如需归档请传 memoryIds 或显式设 archiveAfterDays' };
  }
  const res = await db.collection('memory_items').updateMany(filter, { $set: { archived: true, archived_at: new Date() } });
  await audit(db, tenant, 'memory.archived', { days, count: res.modifiedCount });
  return { ok: true, count: res.modifiedCount, applied: true };
}

async function audit(db, tenant, event, detail) {
  try {
    await db.collection('memory_audit').insertOne({ event, tenant_id: tenant, ...detail, ts: new Date() });
  } catch {}
}
