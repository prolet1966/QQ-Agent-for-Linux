// music-skill —— LLM 型技能：B站点歌（宿主 play_music 语义照搬）
//
// 清单 §4.4：「B 站点歌 | play_music（「我想听 X」→ 搜歌发歌）」
// 宿主把它做成了 data/plugins 里的 bili-music.mjs 插件（宿主**未装**），V0.3.1 没有对应物。
//
// 复用 V0.3.1 **自带** plugins/media-download 里的 bili.js（搜索/取流/下载/ffmpeg 都已实现），
// 只补"挑音频轨 → 当语音发出去"这一段。用**动态 import**：media-download 不在时工具如实报错，不崩。
//
// 为什么缓存写 DATA_DIR 而不是 process.cwd()/data：
//   bili.js 里 CACHE_DIR 用的是 process.cwd()/data/media-cache —— 多实例下两个实例会
//   写同一个目录（就是我们在 affinity/body-state 上修过的那个坑）。这里用自己的
//   DATA_DIR/music-cache，保证实例 #2 写进 data-2/。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const CACHE_DIR = path.join(DATA_DIR, 'music-cache');
const MAX_KEEP = 40;   // 缓存最多留几个文件

export function setup(api) {
  const ok = (d) => ({ content: typeof d === 'string' ? d : JSON.stringify(d, null, 2) });
  const err = (m) => ({ content: m, isError: true });

  /** 懒加载 media-download 的 bili.js（不在就返回 null）。 */
  let biliModCache = null;
  async function bili() {
    if (biliModCache !== null) return biliModCache;
    try {
      biliModCache = await import('../../plugins/media-download/bili.js');
    } catch {
      biliModCache = false;
    }
    return biliModCache;
  }

  /** 清掉过老的缓存文件，避免无限增长。 */
  function cleanup() {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const files = fs.readdirSync(CACHE_DIR)
        .map((n) => ({ n, p: path.join(CACHE_DIR, n) }))
        .map((x) => ({ ...x, t: (() => { try { return fs.statSync(x.p).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.t - a.t);
      for (const f of files.slice(MAX_KEEP)) { try { fs.unlinkSync(f.p); } catch { /* 忽略 */ } }
    } catch { /* 清理失败不影响主流程 */ }
  }

  api.registerTool({
    id: 'play_music',
    name: '点歌',
    description: '群友说「我想听 X」「放首 X」时用：到 B站搜这首歌，把音频当成语音发出去，同时告诉大家是什么歌。只搜不做别的；找不到就如实说没找到，不要编歌名。',
    category: 'media',
    icon: '🎵',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '歌名，可带歌手，例如「夜空中最亮的星 逃跑计划」' },
        maxDurationMin: { type: 'integer', description: '可选：时长上限（分钟），默认 8' },
      },
      required: ['keyword'],
    },
    async execute(ctx, args) {
      const keyword = String(args.keyword ?? '').trim();
      if (!keyword) return err('要听什么歌？把歌名告诉我。');
      const b = await bili();
      if (!b) return err('点歌需要 plugins/media-download 插件（它带着 B站 搜索与下载实现）；请在插件页启用后重试。');

      const c = api.config() || {};
      const sessdata = String(c.sessdata || '').trim();
      const maxDurMin = Math.max(1, Number(args.maxDurationMin) || Number(c.maxDurationMin) || 8);
      const maxBytes = Math.max(5 * 1024 * 1024, (Number(c.maxSizeMB) || 20) * 1024 * 1024);

      try {
        // ① 搜索（B站搜索必须要 WBI 签名 + SESSDATA，匿名会返回风控页）
        if (!sessdata) {
          return err('B站搜索需要 SESSDATA：请在「设置 → 插件 → 点歌」里填 B站 的 SESSDATA（浏览器登录 B站 后从 Cookie 里取）。');
        }
        const res = await b.searchVideos(keyword, { sessdata, limit: 20 });
        const list = Array.isArray(res) ? res : (res?.result || []);
        if (!list.length) return err('B站没搜到《' + keyword + '》，换首歌名或加上歌手试试。');
        const ranked = typeof b.rankCandidates === 'function' ? b.rankCandidates(list, keyword) : list;
        const top = (ranked && ranked[0]) || list[0];
        const bvid = b.extractBvid ? b.extractBvid(String(top.bvid || top.arcurl || '')) : String(top.bvid || '');
        if (!bvid) return err('搜到了结果但解析不出视频号，换一首试试。');

        // ② 视频信息（拿 cid 与时长）
        const info = await b.getVideoInfo(bvid, sessdata);
        const title = String(info?.title || top.title || keyword).replace(/<[^>]+>/g, '').slice(0, 80);
        const dur = Number(info?.duration) || 0;
        if (dur > maxDurMin * 60) {
          return err('《' + title + '》有 ' + Math.round(dur / 60) + ' 分钟，超过 ' + maxDurMin + ' 分钟上限。想听长的可以把设置里的上限调高。');
        }

        // ③ 取 DASH 音频轨
        const playData = await b.getPlayUrl(bvid, info.cid, 16, sessdata);
        const aStream = b.pickAudioStream(playData?.dash?.audio || []);
        if (!aStream) return err('《' + title + '》没有可用的音频轨（可能是付费/版权限制）。');

        // ④ 下载音频（候选 CDN 会依次试）
        cleanup();
        const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
        const outPath = path.join(CACHE_DIR, safe + '_' + bvid + '.m4a');
        const aUrl = b.streamCandidates(aStream.baseUrl || aStream.base_url, aStream.backup_url);
        if (!fs.existsSync(outPath)) {
          await b.downloadStreamToFile(aUrl, outPath, maxBytes, bvid, sessdata);
        }
        if (!fs.existsSync(outPath)) return err('音频没下下来（可能是 CDN 风控或超时），稍后再试。');
        if (b.fileMagicType && !b.fileMagicType(outPath)) {
          try { fs.unlinkSync(outPath); } catch { /* 忽略 */ }
          return err('下到的不是音频内容（CDN 返回了风控页），稍后再试。');
        }

        // ⑤ 当语音发出去（走 ctx.sender，不绕开限频与留档）
        if (!ctx?.sender?.sendMedia) return err('当前核心不支持发媒体段（ctx.sender.sendMedia 缺失）。');
        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: outPath } }], {
          label: '[语音]' + title,
        });
        return ok({
          ok: true,
          歌名: title,
          时长秒: dur,
          来源: 'https://www.bilibili.com/video/' + bvid,
          note: '音频已经作为语音发出去了。一句话说一下歌名和谁唱的就行，不要复述链接。',
        });
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (b.briefFailure) return err('点歌失败：' + b.briefFailure(e));
        return err('点歌失败：' + msg);
      }
    },
  });
}

export function available() {
  return { ok: true, reason: '工具可用（复用 plugins/media-download 的 B站 实现；需配 SESSDATA）' };
}
