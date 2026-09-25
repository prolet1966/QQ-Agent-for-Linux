// 文本工具插件（示例）
// 演示如何注册多个工具

export function register(api) {
  // 工具 1：文本反转
  api.registerTool({
    id: 'text_reverse',
    name: '文本反转',
    description: '把一段文字倒过来。适用：群友让你"倒着说"、玩文字游戏。',
    category: 'system',
    icon: '🔄',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要反转的文字' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '');
      if (!text) return { content: '错误：请提供要反转的文字', isError: true };
      const reversed = [...text].reverse().join('');
      return { content: JSON.stringify({ original: text, reversed }, null, 1) };
    }
  });

  // 工具 2：字数统计
  api.registerTool({
    id: 'text_count',
    name: '字数统计',
    description: '统计一段文字的字数、字符数、行数。适用：群友问"这段话多少字"。',
    category: 'system',
    icon: '🔢',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要统计的文字' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '');
      if (!text) return { content: '错误：请提供要统计的文字', isError: true };

      const stats = {
        chars: text.length,
        charsNoSpace: text.replace(/\s/g, '').length,
        words: text.split(/\s+/).filter(Boolean).length,
        lines: text.split(/\r?\n/).length,
        chineseChars: (text.match(/[\u4e00-\u9fa5]/g) || []).length
      };

      return {
        content: JSON.stringify({
          ...stats,
          note: `共 ${stats.chars} 个字符（含空格），${stats.chineseChars} 个汉字，${stats.words} 个词，${stats.lines} 行`
        }, null, 1)
      };
    }
  });
}
