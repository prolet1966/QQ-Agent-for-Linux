// setu 常量与标签 Set 集中管理（从 setu.js 提取，减少主文件行数）。
// 纯数据/常量，无逻辑，零副作用。
import path from 'node:path';
const DATA_DIR = process.cwd();

// ── 路径与超时 ──────────────────────────────────────────────────
export const TMP_DIR = path.join(DATA_DIR, 'setu-tmp');
export const TMP_MAX_AGE_MS = 60 * 60 * 1000;
export const DEDUP_FILE = path.join(DATA_DIR, 'setu-dedup.json');

// ── 下载常量 ──────────────────────────────────────────────────
export const MAX_COUNT = 10;
export const IMAGE_REFERER = 'https://weibo.com/';
export const IMAGE_UA = 'Mozilla/5.0 (X11; Linux x8_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
export const PIXIV_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  origin: 'https://pixiv.pictures',
  referer: 'https://pixiv.pictures/'
};

// ── Pixiv CDN 镜像 ──────────────────────────────────────────────
export const PXIMG_MIRRORS = ['ext.pximg.net', 'p1.pximg.net', 'p2.pximg.net', 'ext-tl.pximg.net'];
export const PXIMG_BAD_TTL_MS = 30 * 60 * 1000;
export const PROXY_DOWN_COOLDOWN_MS = 60_000;

// ── 搜索缓存 ──────────────────────────────────────────────────
export const PIXIV_PAGE_SIZE = 30;
export const PIXIV_SEARCH_MAX_BYTES = 400000;
export const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
export const SEARCH_CACHE_MAX = 100;
export const AUTOCOMPLETE_CACHE_MAX = 200;
export const BOORU_SEARCH_CACHE_TTL = 15 * 60 * 1000;
export const BOORU_SEARCH_CACHE_MAX = 50;
export const BOORU_TAG_SAMPLE_SIZE = 5;

// ── 附加搜索标签池 ──────────────────────────────────────────────
export const EXTRA_SEARCH_TAGS = ['美少女', '少女', '日常', '1人', '背景詳細', '萌え', '愛', 'かわいい', '笑顔', '見上げ'];

// ── NSFW 触发词正则 ──────────────────────────────────────────────
export const NSFW_TRIGGER_RE = /(色情|福利|色图|黄图|h图|涩图|擦边|福利姬|r18|18禁|成人)/i;

// ── 标签 Set 数据 ──────────────────────────────────────────────

/** 双人/多人图标签（soloOnly 时跳过这些）。 */
export const MULTI_PERSON_TAGS = new Set([
  '2girls', '2boys', '3girls', '3boys', '4girls', '4boys',
  'multiple_girls', 'multiple_boys', 'multiple_people',
  'group', 'multiple', '2人', '3人', '4人', '複数人', '多人'
]);

/** 通用描述标签（不是角色名）。 */
export const GENERIC_TAGS = new Set([
  // 质量/推荐
  'masterpiece', 'highres', 'best', 'featured', 'featured_home',
  'featured_bookmark', 'featured_original', 'pixiv_selected',
  // 通用描述
  'original', 'オリジナル', 'illustration', 'イラスト', 'picture', '画像',
  'girl', 'girls', 'boy', 'boys', 'girl1', 'boy1',
  '女の子', '少年', '少女', '美少女', '少年', '男性', '女性',
  // 同人/原作
  'doujin', '同人', 'derivative', '二次创作', '描改',
  // 场景
  'outdoors', 'indoors', '户外', '室内',
  // 其他通用
  'solo', '1人', '1girl', '1boy', '单人',
  // 表情
  'smile', '微笑', '笑', 'expression', '表情',
  // 动作
  'pose', '姿势', 'action', '动作',
  // 背景
  'background', '背景', 'scene', '场景',
  // 服装
  'clothes', '服装', 'wear', '穿着',
  // 发色
  'hair', '头发', '发色', 'haircolor',
  // 眼睛
  'eyes', '眼睛', '眼色', 'eyecolor',
  // 通用名词
  'art', '画', 'drawing', 'sketch', '草图',
  'color', 'coloring', '彩色', '上色',
  // 作品名（常见）
  'anime', '动画', 'manga', '漫画',
  // 通用属性
  'digital', '数码', 'computer', '电脑',
  'painted', '手绘', 'handdrawn',
  // 通用动作
  'standing', '坐', '躺', '躺',
  'kneeling', '跪', 'sitting', 'sitting',
  // 通用表情
  'smiling', '微笑', 'laughing', '笑',
  'crying', '哭', 'sad', '难过',
  // 通用服装
  'shirt', '衬衫', 'dress', '裙子', 'skirt', '上衣',
  'pants', '裤子', 'shorts', '短裤',
  // 通用场景
  'room', '房间', 'school', '学校',
  'street', '街道', 'city', '城市',
  // 通用道具
  'book', '书', 'phone', '手机',
  'camera', '相机', 'music', '音乐',
  // 通用时间
  'morning', '上午', 'afternoon', '下午',
  'evening', '晚上', 'night', '夜晚',
  // 通用天气
  'sunny', '晴天', 'cloudy', '阴天',
  'rain', '雨', 'snow', '雪',
  // 通用季节
  'spring', '春', 'summer', '夏',
  'autumn', '秋', 'winter', '冬'
]);

/** 含男性角色的标签（femaleOnly 时跳过这些）。 */
export const MALE_CHARACTER_TAGS = new Set([
  '男', '男性', '男の子', '少年', 'man', 'male',
  '2boys', '3boys', '4boys', 'multiple_boys'
]);

/** 恐怖/血腥/不适内容标签。 */
export const HORROR_TAGS = new Set([
  '怖い', '怖い絵', '恐怖', 'ホラー', '怪談', 'horror', 'scary',
  '血', '出血', '鮮血', '血飛沫', 'blood', 'bloody', 'bloodshed',
  '残酷', '残虐', 'cruel', 'cruelty',
  'ゴア', 'gore', 'goregalore',
  '死体', '骸骨', '骨', 'corpse', 'skeleton', 'bone',
  '人肉食', 'cannibalism', 'cannibal',
  '剥脱', 'stripping',
  '虐待', '暴力', 'abuse', 'violence',
  '傷', '傷跡', 'wound', 'scar', 'bruise',
  '幽霊', 'ghost', '霊',
  '化け物', '魔物', '悪魔', '怪物', 'monster', 'demon', 'devil',
  '人肉', '人体', '人形', 'doll', 'mannequin',
  '自殺', '自死', '自害', 'suicide', 'self_harm',
  '拷問', 'torture',
  '刺青', 'tattoo',
  '刺々しい', '痛い', 'pain', 'painful',
  '虫', '蛆', '蛆虫', '虫食い', 'parasite', 'insect', 'larva',
  '排泄', '嘔吐', '嘔吐物', '排泄物', 'vomit', 'poo', 'pee',
  '排泄行為', 'poop', 'feces', 'urine',
  '変態', '変態趣味', 'fetish'
]);

/** 质量标签（illustScore 每个 +3 分）。 */
export const QUALITY_TAGS = new Set([
  'masterpiece', 'highres', 'best', 'featured', 'featured_home',
  'featured_bookmark', 'featured_original', 'pixiv_selected'
]);
