// 计算器插件（示例）
// 演示如何安全地执行数学表达式

export function register(api) {
  api.registerTool({
    id: 'calculate',
    name: '计算',
    description: '计算一个数学表达式（支持 + - * / % 括号）。适用：群友问"1+1等于几"、"帮我算一下 123*456"。',
    category: 'system',
    icon: '🧮',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式（如：1+2*3）' }
      },
      required: ['expression']
    },
    async execute(ctx, args) {
      const expr = String(args.expression ?? '').trim();
      if (!expr) return { content: '错误：请提供要计算的表达式', isError: true };

      // 安全检查：只允许数字、运算符、括号、小数点
      if (!/^[\d\s+\-*/%().]+$/.test(expr)) {
        return { content: '错误：表达式包含不允许的字符（只允许数字和 + - * / % ( )）', isError: true };
      }

      try {
        // 使用 Function 构造器（比 eval 安全一点，但仍需输入校验）
        const result = new Function(`return (${expr})`)();
        if (typeof result !== 'number' || !Number.isFinite(result)) {
          throw new Error('计算结果无效');
        }
        return {
          content: JSON.stringify({
            expression: expr,
            result,
            note: `${expr} = ${result}`
          }, null, 1)
        };
      } catch (error) {
        return { content: `计算失败：${error.message}`, isError: true };
      }
    }
  });
}
