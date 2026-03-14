
//基于origin字符串的动态判断
function getCorsHeaders(origin) {
  // 判断 origin 是否以 .apheriai.com 结尾，或者是 https://apheriai.com 本身
  if (origin && (origin.endsWith('.apheriai.com') || origin === 'https://apheriai.com')) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
  }
  // 如果 origin 不符合条件，返回空对象（不设置 CORS 头）
  return {};
}

// 错误响应
function errorResponse(message, status = 400, origin = '') {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin),
    },
  });
}

// 成功响应
function successResponse(data, origin = '') {
  return new Response(JSON.stringify({ success: true, result: data }), {
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin),
    },
  });
}

// 频率限制（使用 KV）
async function checkRateLimit(ip, env, origin) {
  if (!env.KV_NAMESPACE) return true; // 未配置KV则跳过
  const key = `ratelimit:${ip}`;
  const current = await env.KV_NAMESPACE.get(key);
  const limit = 100; // 每天最多100次调用
  if (current && parseInt(current) >= limit) {
    return false;
  }
  const count = current ? parseInt(current) + 1 : 1;
  await env.KV_NAMESPACE.put(key, count.toString(), { expirationTtl: 86400 });
  return true;
}

// 处理 DeepSeek API 调用的函数
async function handleAIAssistant(request, env, ctx) {
  const origin = request.headers.get('Origin') || '';
  
  // 处理 OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: getCorsHeaders(origin) });
  }

  // 仅允许 POST
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405, origin);
  }

  // 获取客户端 IP（用于频率限制）
  const clientIP = request.headers.get('CF-Connecting-IP') || '';

  try {
    // 频率限制检查
    if (!await checkRateLimit(clientIP, env, origin)) {
      return errorResponse('今日调用次数已达上限（100次）', 429, origin);
    }

    // 解析请求体
    const body = await request.json();
    const { action, data } = body;

    // 验证 action
    if (!action || !['optimize-resume', 'interview-feedback'].includes(action)) {
      return errorResponse('无效的 action', 400, origin);
    }

    // 验证必要字段
    if (action === 'optimize-resume' && (!data?.resume || !data?.jobTarget)) {
      return errorResponse('缺少 resume 或 jobTarget', 400, origin);
    }
    if (action === 'interview-feedback' && (!data?.question || !data?.answer || !data?.job)) {
      return errorResponse('缺少 question/answer/job', 400, origin);
    }

    // 构建系统提示词
    let systemPrompt = '';
    let userPrompt = '';
    if (action === 'optimize-resume') {
      systemPrompt = `你是一位资深的简历优化专家。请根据目标岗位优化简历，要求：
1. 使用量化表达（用具体数字突出业绩）
2. 使用主动语态和强动词（如"主导"、"负责"、"实现"）
3. 保持真实，不编造经历
4. 可以用星号(*)标注重点内容，让用户一目了然
5. 返回格式：优化后的完整简历，段落清晰`;
      userPrompt = `目标岗位：${data.jobTarget}\n\n原始简历：\n${data.resume}`;
    } else {
      systemPrompt = `你是一位专业的${data.job}面试官。请对面试者的回答进行点评，要求：
1. 指出回答的优点
2. 指出不足之处
3. 提供更好的回答思路或建议
4. 可以用星号(*)标注重点建议
5. 返回格式：段落清晰，便于阅读`;
      userPrompt = `面试问题：${data.question}\n\n面试者回答：${data.answer}`;
    }

    // 调用 DeepSeek API
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return errorResponse('服务器配置错误：未设置 API 密钥', 500, origin);
    }

    const deepseekResponse = await fetch(DEEPSEEK_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 3000,
        stream: false,
      }),
    });

    if (!deepseekResponse.ok) {
      const errorData = await deepseekResponse.json();
      console.error('DeepSeek API 错误:', errorData);
      return errorResponse(`AI 服务调用失败: ${deepseekResponse.status}`, 502, origin);
    }

    const result = await deepseekResponse.json();
    const aiMessage = result.choices[0].message.content;

    // 可选：记录调用日志到 KV（用于统计）
    if (env.KV_NAMESPACE) {
      const logKey = `log:${new Date().toISOString().slice(0, 10)}`;
      const currentLog = await env.KV_NAMESPACE.get(logKey) || '0';
      await env.KV_NAMESPACE.put(logKey, (parseInt(currentLog) + 1).toString());
    }

    return successResponse(aiMessage, origin);
  } catch (error) {
    console.error('Worker 内部错误:', error);
    return errorResponse('服务器内部错误', 500, origin);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // 原有的 /api/hello 路由
    if (url.pathname === '/api/hello') {
      return new Response(JSON.stringify({ 
        message: 'Hello from your first Worker!',
        status: 'success'
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }

    // 原有的 /api/resume/analyze 路由（如果你还想保留）
    if (url.pathname === '/api/resume/analyze' && request.method === 'POST') {
      // 这里可以放你之前写的基于 Workers AI 的简历分析代码
      // 为了简洁，此处省略，你可以把之前的那段逻辑放回来
      return new Response('这个路由暂时停用，请使用 /api/ai-assistant', { status: 200 });
    }

    // 新增的 /api/ai-assistant 路由
    if (url.pathname === '/api/ai-assistant') {
      return handleAIAssistant(request, env, ctx);
    }

    // 根目录提示
    if (url.pathname === '/') {
      return new Response('Welcome to AI Job Assistant API! Try /api/hello or POST /api/ai-assistant', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // 其他路径返回 404
    return new Response('Not Found', { status: 404 });
  },
};
