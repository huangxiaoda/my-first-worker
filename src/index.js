// ==================== 配置区 ====================
// 用户套餐限额定义（每月）
const PLAN_LIMITS = {
  'free': 90,      // 每日3次 ≈ 每月90次
  'monthly': 100,
  'quarterly': 100,
  'yearly': 100
};

// KV 键前缀
const KV_KEYS = {
  USER_PLAN: 'user:plan:',    // 用户套餐类型
  USER_USAGE: 'user:usage:'   // 当月已用次数（按月）
};

const DEEPSEEK_API_ENDPOINT = "https://api.deepseek.com/chat/completions";
// ================================================

// 基于 origin 字符串的动态判断（CORS）
function getCorsHeaders(origin) {
  // 允许无 origin（如 file:// 或打包后的 App）以及特定域名
  if (!origin || origin === 'null' || origin.endsWith('.apheriai.com') || origin === 'https://apheriai.com') {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
  }
  // 如果 origin 不符合条件，返回空对象（不设置 CORS 头）
  return {};
}

// 错误响应（可携带额外字段）
function errorResponse(message, status = 400, origin = '', extra = {}) {
  return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(origin),
    },
  });
}

// 成功响应（支持额外字段）
function successResponse(data, origin = '', extra = {}) {
  return new Response(JSON.stringify({ success: true, result: data, ...extra }), {
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

// 获取当前月份字符串（用于按月统计）
function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

// 检查用户额度（核心函数）
async function checkUserQuota(userId, env, origin) {
  if (!env.KV_NAMESPACE) return { allowed: true, remaining: 999 }; // 无KV则跳过
  const month = getCurrentMonth();
  const planKey = KV_KEYS.USER_PLAN + userId;
  const usageKey = KV_KEYS.USER_USAGE + userId + ':' + month;

  // 获取用户套餐类型，默认为免费
  let plan = await env.KV_NAMESPACE.get(planKey) || 'free';
  // 获取当月已用次数
  let used = parseInt(await env.KV_NAMESPACE.get(usageKey) || '0');

  const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const remaining = limit - used;

  if (remaining <= 0) {
    return { allowed: false, reason: '当月次数已用完，请升级套餐或下月再来' };
  }

  // 返回允许，并带上剩余次数等信息
  return { allowed: true, remaining, plan, used, limit };
}

// 增加用户使用次数（在调用AI成功后调用）
async function incrementUserUsage(userId, env) {
  if (!env.KV_NAMESPACE) return;
  const month = getCurrentMonth();
  const usageKey = KV_KEYS.USER_USAGE + userId + ':' + month;
  const current = parseInt(await env.KV_NAMESPACE.get(usageKey) || '0');
  await env.KV_NAMESPACE.put(usageKey, (current + 1).toString(), { expirationTtl: 35 * 24 * 3600 }); // 保留35天
}

// 更新用户套餐（支付成功后调用）
async function updateUserPlan(userId, planType, env) {
  if (!env.KV_NAMESPACE) return;
  const planKey = KV_KEYS.USER_PLAN + userId;
  await env.KV_NAMESPACE.put(planKey, planType);
}

// 处理 DeepSeek API 调用的函数（核心AI服务）
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
    // 解析请求体
    const body = await request.json();
    const { action, data } = body;

    // ===== 1. 处理 test 请求（优先，不检查频率限制，但可返回剩余次数）=====
    if (action === 'test') {
      const userId = data?.userId;
      if (userId) {
        const quota = await checkUserQuota(userId, env, origin);
        // 返回连接成功，同时携带剩余次数
        return new Response(JSON.stringify({
          success: true,
          result: '连接成功',
          remaining: quota.remaining
        }), {
          headers: { 'Content-Type': 'application/json', ...getCorsHeaders(origin) }
        });
      } else {
        return successResponse('连接成功', origin);
      }
    }

    // ===== 2. 非 test 请求：先进行频率限制 =====
    if (!await checkRateLimit(clientIP, env, origin)) {
      return errorResponse('今日调用次数已达上限（100次）', 429, origin);
    }

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

    // ===== 3. 用户额度检查 =====
    const userId = data?.userId;
    if (!userId) {
      return errorResponse('缺少用户标识 userId', 400, origin);
    }

    const quotaCheck = await checkUserQuota(userId, env, origin);
    if (!quotaCheck.allowed) {
      return errorResponse(quotaCheck.reason, 403, origin);
    }

    // 将剩余次数暂存，以便返回时携带
    const remaining = quotaCheck.remaining;

    // ===== 4. 构建提示词 =====
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

    // ===== 5. 调用 DeepSeek API =====
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

    // ===== 6. 记录调用日志（可选）=====
    if (env.KV_NAMESPACE) {
      const logKey = `log:${new Date().toISOString().slice(0, 10)}`;
      const currentLog = await env.KV_NAMESPACE.get(logKey) || '0';
      await env.KV_NAMESPACE.put(logKey, (parseInt(currentLog) + 1).toString());
    }

    // ===== 7. 增加用户使用次数（异步，忽略错误）=====
    incrementUserUsage(userId, env).catch(e => console.error('增量记录失败:', e));

    // ===== 8. 返回成功结果，并附带剩余次数 =====
    return successResponse(aiMessage, origin, { remaining });
  } catch (error) {
    console.error('Worker 内部错误:', error);
    return errorResponse('服务器内部错误', 500, origin);
  }
}

// 处理套餐升级（支付成功回调）
async function handleUpgradePlan(request, env, ctx) {
  const origin = request.headers.get('Origin') || '';

  // 处理 OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: getCorsHeaders(origin) });
  }

  try {
    const body = await request.json();
    const { userId, planType, receipt } = body;

    if (!userId || !planType) {
      return errorResponse('缺少 userId 或 planType', 400, origin);
    }

    // TODO: 强烈建议验证苹果收据的真实性（生产环境必须）
    // 此处仅作演示，实际应调用苹果验证接口
    console.log('收到升级请求', { userId, planType, receipt });

    // 更新用户套餐
    await updateUserPlan(userId, planType, env);

    return successResponse({ message: '套餐升级成功' }, origin);
  } catch (error) {
    console.error('升级套餐错误:', error);
    return errorResponse('服务器内部错误', 500, origin);
  }
}

// ==================== 主入口 ====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // 原有的 /api/hello 路由（仅用于测试）
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

    // 原有的 /api/resume/analyze 路由（暂时停用）
    if (url.pathname === '/api/resume/analyze' && request.method === 'POST') {
      return new Response('这个路由暂时停用，请使用 /api/ai-assistant', { status: 200 });
    }

    // 新增的 /api/ai-assistant 路由
    if (url.pathname === '/api/ai-assistant') {
      return handleAIAssistant(request, env, ctx);
    }

    // 套餐升级路由
    if (url.pathname === '/api/upgrade-plan' && request.method === 'POST') {
      return handleUpgradePlan(request, env, ctx);
    }

    // 根目录提示
    if (url.pathname === '/') {
      return new Response(
        'Welcome to AI Job Assistant API! Try /api/hello or POST /api/ai-assistant',
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    // 其他路径返回 404
    return new Response('Not Found', { status: 404 });
  },
};
