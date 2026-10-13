// ==================== 常量定义 ====================
const PLAN_LIMITS = {
  "free": 5,
  "monthly": 100,
  "quarterly": 300,
  "yearly": 1200,
  "token30": 30
};

// ✅ 新增：套餐周期（毫秒）
const PLAN_DURATIONS = {
  "free": 0,
  "monthly": 30 * 24 * 3600 * 1000,
  "quarterly": 90 * 24 * 3600 * 1000,
  "yearly": 365 * 24 * 3600 * 1000
};

const KV_KEYS = {
  USER_PLAN: "user:plan:",
  USER_PLAN_EXPIRES: "user:plan_expires:",   // ✅ 新增
  USER_USAGE: "user:usage:",
  USER_TOKEN: "user:token:"
};

const DEEPSEEK_API_ENDPOINT = "https://api.deepseek.com/chat/completions";

// ==================== 辅助函数 ====================

function getCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function errorResponse(message, status = 400, origin = "", extra = {}) {
  return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}

function successResponse(data, origin = "", extra = {}) {
  return new Response(JSON.stringify({ success: true, result: data, ...extra }), {
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}

async function checkRateLimit(ip, env, origin) {
  if (!env.KV_NAMESPACE) return true;
  const key = `ratelimit:${ip}`;
  const current = await env.KV_NAMESPACE.get(key);
  const limit = 100;
  if (current && parseInt(current) >= limit) return false;
  const count = current ? parseInt(current) + 1 : 1;
  await env.KV_NAMESPACE.put(key, count.toString(), { expirationTtl: 86400 });
  return true;
}

function mapProductIdToPlan(productId) {
  if (productId === "com.apheriai.aijob.monthly") return "monthly";
  if (productId === "com.apheriai.aijob.quarterly") return "quarterly";
  if (productId === "com.apheriai.aijob.yearly") return "yearly";
  if (productId === "com.apheriai.aijob.token30") return "token30";
  return null;
}

// ==================== ✅ 周期计算 ====================

// 计算当前周期起始时间戳（基于套餐到期时间倒推）
function getCurrentPeriodStart(expiresAt, durationMs) {
  const now = Date.now();
  if (!expiresAt || !durationMs || now >= expiresAt) {
    // 没到期时间或已过期，按当前时间算一个新周期
    return now;
  }
  // 距离到期还有多久
  const remaining = expiresAt - now;
  // 已经过去了多少个完整周期
  const elapsed = durationMs - (remaining % durationMs);
  // 当前周期起始 = now - elapsed
  return now - (elapsed % durationMs);
}

// 计算新周期的到期时间（购买时用）
function getNewExpiresAt(planType, currentExpiresAt) {
  const duration = PLAN_DURATIONS[planType] || 0;
  if (!duration) return 0;
  const base = (currentExpiresAt && currentExpiresAt > Date.now())
    ? currentExpiresAt   // 续费：从旧到期时间往后延
    : Date.now();        // 新购：从现在开始
  return base + duration;
}

// ==================== token 余额 ====================

async function getTokenBalance(userId, env) {
  if (!env.KV_NAMESPACE) return 0;
  const key = KV_KEYS.USER_TOKEN + userId;
  const val = await env.KV_NAMESPACE.get(key);
  return parseInt(val || "0", 10) || 0;
}

async function addTokenBalance(userId, amount, env) {
  if (!env.KV_NAMESPACE) return 0;
  const key = KV_KEYS.USER_TOKEN + userId;
  const current = await getTokenBalance(userId, env);
  const next = current + amount;
  await env.KV_NAMESPACE.put(key, next.toString());
  return next;
}

async function consumeTokenBalance(userId, env) {
  if (!env.KV_NAMESPACE) return false;
  const key = KV_KEYS.USER_TOKEN + userId;
  const current = await getTokenBalance(userId, env);
  if (current <= 0) return false;
  await env.KV_NAMESPACE.put(key, (current - 1).toString());
  return true;
}

// ==================== ✅ 配额检查（含过期判断） ====================

async function checkUserQuota(userId, env) {
  if (!env.KV_NAMESPACE) return { allowed: true, remaining: 999 };

  const now = Date.now();
  const planKey = KV_KEYS.USER_PLAN + userId;
  const expiresKey = KV_KEYS.USER_PLAN_EXPIRES + userId;

  let plan = await env.KV_NAMESPACE.get(planKey) || "free";
  if (!PLAN_LIMITS[plan]) plan = "free";

  // ✅ token30 走独立分支
  if (plan === "token30") {
    const tokenBalance = await getTokenBalance(userId, env);
    if (tokenBalance > 0) {
      return {
        allowed: true,
        remaining: tokenBalance,
        plan: "token30",
        used: 0,
        limit: tokenBalance,
        source: "token"
      };
    }
    // token 用完，降级 free
    plan = "free";
  }

  // ✅ 订阅类：检查是否过期
  if (plan !== "free") {
    const expiresAt = parseInt(await env.KV_NAMESPACE.get(expiresKey) || "0", 10);
    if (expiresAt && expiresAt <= now) {
      // 已过期，降级到 free
      await env.KV_NAMESPACE.put(planKey, "free");
      plan = "free";
    }
  }

  // 计算当前周期的 usage key
  const expiresAt = parseInt(await env.KV_NAMESPACE.get(expiresKey) || "0", 10);
  const duration = PLAN_DURATIONS[plan] || 0;
  const periodStart = duration > 0
    ? getCurrentPeriodStart(expiresAt, duration)
    : 0;
  const usageKey = periodStart > 0
    ? KV_KEYS.USER_USAGE + userId + ":" + periodStart
    : KV_KEYS.USER_USAGE + userId + ":free";

  let used = parseInt(await env.KV_NAMESPACE.get(usageKey) || "0", 10);
  if (isNaN(used) || used < 0) used = 0;

  const limit = PLAN_LIMITS[plan];
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) {
    // ✅ 订阅额度用完，看 token 余额
    const tokenBalance = await getTokenBalance(userId, env);
    if (tokenBalance > 0) {
      return {
        allowed: true,
        remaining: tokenBalance,
        plan: "token30",
        used: 0,
        limit: tokenBalance,
        source: "token"
      };
    }
    return { allowed: false, reason: "次数已用完，请升级套餐或购买次数包" };
  }

  return { allowed: true, remaining, plan, used, limit, source: "plan" };
}

// ==================== ✅ 扣次数 ====================

async function incrementUserUsage(userId, env) {
  if (!env.KV_NAMESPACE) return;

  const now = Date.now();
  const planKey = KV_KEYS.USER_PLAN + userId;
  const expiresKey = KV_KEYS.USER_PLAN_EXPIRES + userId;

  let plan = await env.KV_NAMESPACE.get(planKey) || "free";
  if (!PLAN_LIMITS[plan]) plan = "free";

  // 检查过期
  if (plan !== "free" && plan !== "token30") {
    const expiresAt = parseInt(await env.KV_NAMESPACE.get(expiresKey) || "0", 10);
    if (expiresAt && expiresAt <= now) {
      await env.KV_NAMESPACE.put(planKey, "free");
      plan = "free";
    }
  }

  const limit = PLAN_LIMITS[plan] || 5;
  const duration = PLAN_DURATIONS[plan] || 0;
  const expiresAt = parseInt(await env.KV_NAMESPACE.get(expiresKey) || "0", 10);
  const periodStart = duration > 0
    ? getCurrentPeriodStart(expiresAt, duration)
    : 0;
  const usageKey = periodStart > 0
    ? KV_KEYS.USER_USAGE + userId + ":" + periodStart
    : KV_KEYS.USER_USAGE + userId + ":free";

  const current = parseInt(await env.KV_NAMESPACE.get(usageKey) || "0", 10);

  if (current < limit) {
    // 订阅额度还有，扣订阅
    await env.KV_NAMESPACE.put(usageKey, (current + 1).toString(), {
      expirationTtl: 400 * 24 * 3600  // 保留 400 天，方便回溯
    });
  } else {
    // 订阅用完，扣 token
    await consumeTokenBalance(userId, env);
  }
}

async function updateUserPlan(userId, planType, env) {
  if (!env.KV_NAMESPACE) return;
  const planKey = KV_KEYS.USER_PLAN + userId;
  await env.KV_NAMESPACE.put(planKey, planType);
}

// ==================== ✅ 应用套餐（含周期设置） ====================

async function applyPlan(userId, planType, env) {
  if (!env.KV_NAMESPACE) return;

  // token30：累加到独立余额
  if (planType === "token30") {
    await addTokenBalance(userId, 30, env);
    return;
  }

  const planKey = KV_KEYS.USER_PLAN + userId;
  const expiresKey = KV_KEYS.USER_PLAN_EXPIRES + userId;
  const currentPlan = await env.KV_NAMESPACE.get(planKey) || "free";
  const currentExpires = parseInt(await env.KV_NAMESPACE.get(expiresKey) || "0", 10);

  // ✅ 计算新的到期时间
  let newExpires;
  if (currentPlan === planType && currentExpires > Date.now()) {
    // 同档位续费：从旧到期时间往后延
    newExpires = currentExpires + PLAN_DURATIONS[planType];
  } else {
    // 新购或升级：从现在开始
    newExpires = Date.now() + PLAN_DURATIONS[planType];
  }

  await updateUserPlan(userId, planType, env);
  await env.KV_NAMESPACE.put(expiresKey, newExpires.toString());

  // ✅ 升级/降级时清零 usage（同档位续费不清零，因为周期延续）
  if (currentPlan !== planType) {
    // 档位变化，新周期从 0 开始
    const newUsageKey = KV_KEYS.USER_USAGE + userId + ":" + getCurrentPeriodStart(newExpires, PLAN_DURATIONS[planType]);
    await env.KV_NAMESPACE.put(newUsageKey, "0");
  }
}

// ==================== 苹果收据验证 ====================

async function verifyAppleReceipt(receipt, env) {
  const sharedSecret = env.APPLE_SHARED_SECRET || null;
  const payload = { "receipt-data": receipt };
  if (sharedSecret) payload.password = sharedSecret;

  let verifyRes = await fetch("https://buy.itunes.apple.com/verifyReceipt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let verifyResult = await verifyRes.json();

  if (verifyResult.status === 21007) {
    verifyRes = await fetch("https://sandbox.itunes.apple.com/verifyReceipt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    verifyResult = await verifyRes.json();
  }

  return verifyResult;
}

function extractAnyOriginalTransactionId(verifyResult) {
  const purchases = verifyResult.latest_receipt_info
    || verifyResult.receipt?.in_app
    || [];
  let latest = null;
  let latestTime = 0;
  for (const p of purchases) {
    const t = parseInt(p.purchase_date_ms || "0", 10);
    if (t > latestTime) {
      latestTime = t;
      latest = p;
    }
  }
  return latest?.original_transaction_id || null;
}

// ✅ 找出所有有效订阅，按有效期从晚到早排序
function findActivePlansSorted(verifyResult) {
  const purchases = verifyResult.latest_receipt_info
    || verifyResult.receipt?.in_app
    || [];
  const now = Date.now();

  const latestByGroup = {};
  for (const p of purchases) {
    const planType = mapProductIdToPlan(p.product_id);
    if (!planType) continue;
    if (planType === "token30") continue;

    const expires = parseInt(p.expires_date_ms || "0", 10);
    if (!expires || expires < now) continue;

    const groupId = p.original_transaction_id || p.transaction_id;
    if (!latestByGroup[groupId] || expires > latestByGroup[groupId].expires) {
      latestByGroup[groupId] = {
        planType,
        expires,
        originalTransactionId: groupId
      };
    }
  }

  return Object.values(latestByGroup).sort((a, b) => b.expires - a.expires);
}

// ==================== AI 助手处理 ====================

async function handleAIAssistant(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });
  if (request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

  try {
    const body = await request.json();
    const { action, data } = body;

    if (action === "test") {
      if (data?.userId) {
        const quota = await checkUserQuota(data.userId, env);
        return new Response(JSON.stringify({ success: true, result: "连接成功", remaining: quota.remaining }), {
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      return successResponse("连接成功", origin);
    }

    const clientIP = request.headers.get("CF-Connecting-IP") || "";
    if (!await checkRateLimit(clientIP, env, origin)) {
      return errorResponse("今日调用次数已达上限（100次）", 429, origin);
    }

    if (!action || !["optimize-resume", "interview-feedback"].includes(action)) {
      return errorResponse("无效的 action", 400, origin);
    }

    if (action === "optimize-resume" && (!data?.resume || !data?.jobTarget)) {
      return errorResponse("缺少 resume 或 jobTarget", 400, origin);
    }
    if (action === "interview-feedback" && (!data?.question || !data?.answer || !data?.job)) {
      return errorResponse("缺少 question/answer/job", 400, origin);
    }

    const userId = data?.userId;
    if (!userId) return errorResponse("缺少用户标识 userId", 400, origin);

    const quotaCheck = await checkUserQuota(userId, env);
    if (!quotaCheck.allowed) return errorResponse(quotaCheck.reason, 403, origin);

    let systemPrompt = "", userPrompt = "";
    if (action === "optimize-resume") {
      systemPrompt = `你是一位资深的简历优化专家。请根据目标岗位优化简历，要求：
1. 使用量化表达（用具体数字突出业绩）
2. 使用主动语态和强动词（如"主导"、"负责"、"实现"）
3. 保持真实，不编造经历
4. 可以用星号(*)标注重点内容，让用户一目了然
5. 返回格式：优化后的完整简历，段落清晰`;
      userPrompt = `目标岗位：${data.jobTarget}\n原始简历：\n${data.resume}`;
    } else {
      systemPrompt = `你是一位专业的${data.job}面试官。请对面试者的回答进行点评，要求：
1. 指出回答的优点
2. 指出不足之处
3. 提供更好的回答思路或建议
4. 可以用星号(*)标注重点建议
5. 返回格式：段落清晰，便于阅读`;
      userPrompt = `面试问题：${data.question}\n面试者回答：${data.answer}`;
    }

    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) return errorResponse("服务器配置错误：未设置 API 密钥", 500, origin);

    const deepseekResponse = await fetch(DEEPSEEK_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        temperature: 0.7,
        max_tokens: 3000,
        stream: false
      })
    });

    if (!deepseekResponse.ok) {
      const errorData = await deepseekResponse.json();
      console.error("DeepSeek API 错误:", errorData);
      return errorResponse(`AI 服务调用失败: ${deepseekResponse.status}`, 502, origin);
    }

    const result = await deepseekResponse.json();
    const aiMessage = result.choices[0].message.content;

    if (env.KV_NAMESPACE) {
      const logKey = `log:${new Date().toISOString().slice(0, 10)}`;
      const currentLog = await env.KV_NAMESPACE.get(logKey) || "0";
      await env.KV_NAMESPACE.put(logKey, (parseInt(currentLog) + 1).toString());
    }

    await incrementUserUsage(userId, env).catch(e => console.error("增量记录失败:", e));
    const finalQuota = await checkUserQuota(userId, env);

    return successResponse(aiMessage, origin, { remaining: finalQuota.remaining });
  } catch (error) {
    console.error("Worker 内部错误:", error);
    return errorResponse("服务器内部错误", 500, origin);
  }
}

// ==================== 验证收据（购买后调用） ====================

async function handleVerifyReceipt(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });
  if (request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

  try {
    const body = await request.json();
    const { receipt, userId: clientUserId, productId: clientProductId } = body;

    if (!receipt || !clientUserId) {
      return errorResponse("缺少 receipt 或 userId", 400, origin);
    }

    const verifyResult = await verifyAppleReceipt(receipt, env);
    if (verifyResult.status !== 0) {
      return errorResponse(`收据验证失败 (状态码 ${verifyResult.status})`, 400, origin);
    }

    const appleUserId = extractAnyOriginalTransactionId(verifyResult);

    let appliedPlan = null;
    if (clientProductId) {
      appliedPlan = mapProductIdToPlan(clientProductId);
    }
    if (!appliedPlan) {
      const current = findActivePlansSorted(verifyResult);
      appliedPlan = current[0]?.planType || null;
    }
    if (!appliedPlan) {
      return errorResponse("未找到有效的内购记录", 400, origin);
    }

    // 用前端传来的 userId（deviceId）作为存储 key
    await applyPlan(clientUserId, appliedPlan, env);

    const finalQuota = await checkUserQuota(clientUserId, env);
    return successResponse(
      {
        message: "验证成功",
        plan: appliedPlan,
        appleUserId: appleUserId || null
      },
      origin,
      { remaining: finalQuota.remaining }
    );
  } catch (error) {
    console.error("验证收据失败:", error);
    return errorResponse("服务器处理失败", 500, origin);
  }
}

// ==================== 恢复购买 ====================

async function handleRestorePurchases(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });

  try {
    const body = await request.json();
    let receipt = body.receipt;
    if (!receipt && Array.isArray(body.receipts) && body.receipts.length > 0) {
      receipt = body.receipts[0];
    }
    const clientUserId = body.userId;

    if (!clientUserId || !receipt) {
      return errorResponse("缺少 userId 或 receipt", 400, origin);
    }

    const verifyResult = await verifyAppleReceipt(receipt, env);
    if (verifyResult.status !== 0) {
      return errorResponse(`收据验证失败 (状态码 ${verifyResult.status})`, 400, origin);
    }

    const appleUserId = extractAnyOriginalTransactionId(verifyResult);
    const activePlans = findActivePlansSorted(verifyResult);

    if (activePlans.length === 0) {
      return errorResponse("没有找到有效的订阅记录", 404, origin);
    }

    // 用前端传来的 userId（deviceId）作为存储 key
    const planKey = KV_KEYS.USER_PLAN + clientUserId;
    const currentPlan = await env.KV_NAMESPACE.get(planKey) || "free";
    const currentLimit = PLAN_LIMITS[currentPlan] || 5;

    const bestRestore = activePlans[0];
    const bestRestoreLimit = PLAN_LIMITS[bestRestore.planType] || 5;

    if (currentPlan !== "free" && currentLimit >= bestRestoreLimit) {
      const finalQuota = await checkUserQuota(clientUserId, env);
      return successResponse(
        {
          message: "恢复成功（当前套餐额度已不低于恢复记录）",
          plan: currentPlan,
          appleUserId: appleUserId || null
        },
        origin,
        { remaining: finalQuota.remaining }
      );
    }

    await applyPlan(clientUserId, bestRestore.planType, env);
    const finalQuota = await checkUserQuota(clientUserId, env);
    return successResponse(
      {
        message: "恢复成功",
        plan: bestRestore.planType,
        appleUserId: appleUserId || null
      },
      origin,
      { remaining: finalQuota.remaining }
    );
  } catch (error) {
    console.error("恢复购买处理失败:", error);
    return errorResponse("服务器处理失败", 500, origin);
  }
}

// ==================== 升级套餐 ====================

async function handleUpgradePlan(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });

  try {
    const body = await request.json();
    const { userId, planType, receipt } = body;
    if (!userId || !planType) return errorResponse("缺少 userId 或 planType", 400, origin);

    if (receipt) {
      const verifyResult = await verifyAppleReceipt(receipt, env);
      if (verifyResult.status !== 0) {
        return errorResponse(`收据验证失败 (${verifyResult.status})`, 400, origin);
      }
    }

    await applyPlan(userId, planType, env);
    return successResponse({ message: "套餐升级成功" }, origin);
  } catch (error) {
    console.error("升级套餐错误:", error);
    return errorResponse("服务器内部错误", 500, origin);
  }
}

// ==================== 入口路由 ====================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: getCorsHeaders(origin) });
    }

    if (url.pathname === "/api/hello") {
      return new Response(JSON.stringify({ message: "Hello", status: "success" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    if (url.pathname === "/api/ai-assistant") return handleAIAssistant(request, env, ctx);
    if (url.pathname === "/api/verify-receipt") return handleVerifyReceipt(request, env, ctx);
    if (url.pathname === "/api/upgrade-plan") return handleUpgradePlan(request, env, ctx);
    if (url.pathname === "/api/restore-purchases") return handleRestorePurchases(request, env, ctx);

    if (url.pathname === "/") {
      return new Response("Welcome to AI Job Assistant API!", {
        headers: { "Content-Type": "text/plain" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
