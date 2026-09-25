// 天气查询插件（示例）
// 演示如何注册一个自定义工具到 QQ Agent

export function register(api) {
  api.registerTool({
    id: 'get_weather',
    name: '查询天气',
    description: '查询指定城市的实时天气。适用：群友问"今天天气怎么样"、"明天会下雨吗"等。',
    category: 'web',
    icon: '🌤️',
    requiresSearch: true,  // 依赖搜索服务（实际用的是 wttr.in 免费 API）
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名（如：北京、上海、深圳）' }
      },
      required: ['city']
    },
    async execute(ctx, args) {
      const city = String(args.city ?? '').trim();
      if (!city) return { content: '错误：请提供城市名', isError: true };

      try {
        // 使用 wttr.in 免费天气 API（无需 key）
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const current = data.current_condition?.[0];
        if (!current) throw new Error('未获取到天气数据');

        const weather = {
          city,
          temp: current.temp_C,
          feelsLike: current.FeelsLikeC,
          humidity: current.humidity,
          desc: current.weatherDesc?.[0]?.value || '未知',
          windSpeed: current.windspeedKmph
        };

        return {
          content: JSON.stringify({
            ...weather,
            note: `当前 ${weather.desc}，气温 ${weather.temp}°C（体感 ${weather.feelsLike}°C），湿度 ${weather.humidity}%，风速 ${weather.windSpeed}km/h`
          }, null, 1)
        };
      } catch (error) {
        return { content: `天气查询失败：${error.message}`, isError: true };
      }
    }
  });
}
