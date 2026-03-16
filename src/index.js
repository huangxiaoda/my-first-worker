var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var PLAN_LIMITS = {
  "free": 90,
  // 免费每月90次
  "monthly": 100,
  "quarterly": 100,
  "yearly": 100
};
var KV_KEYS = {
  USER_PLAN: "user:plan:",
  USER_USAGE: "user:usage:"
};
var DEEPSEEK_API_ENDPOINT = "https://api.deepseek.com/chat/completions";
function getCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
__name(getCorsHeaders, "getCorsHeaders");
function errorResponse(message, status = 400, origin = "", extra = {}) {
  return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}
__name(errorResponse, "errorResponse");
function successResponse(data, origin = "", extra = {}) {
  return new Response(JSON.stringify({ success: true, result: data, ...extra }), {
    headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
  });
}
__name(successResponse, "successResponse");
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
__name(checkRateLimit, "checkRateLimit");
function getCurrentMonth() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}
__name(getCurrentMonth, "getCurrentMonth");
async function checkUserQuota(userId, env) {
  if (!env.KV_NAMESPACE) return { allowed: true, remaining: 999 };
  const month = getCurrentMonth();
  const planKey = KV_KEYS.USER_PLAN + userId;
  const usageKey = KV_KEYS.USER_USAGE + userId + ":" + month;
  let plan = await env.KV_NAMESPACE.get(planKey) || "free";
  let used = parseInt(await env.KV_NAMESPACE.get(usageKey) || "0");
  const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const remaining = limit - used;
  if (remaining <= 0) return { allowed: false, reason: "\u5F53\u6708\u6B21\u6570\u5DF2\u7528\u5B8C\uFF0C\u8BF7\u5347\u7EA7\u5957\u9910\u6216\u4E0B\u6708\u518D\u6765" };
  return { allowed: true, remaining, plan, used, limit };
}
__name(checkUserQuota, "checkUserQuota");
async function incrementUserUsage(userId, env) {
  if (!env.KV_NAMESPACE) return;
  const month = getCurrentMonth();
  const usageKey = KV_KEYS.USER_USAGE + userId + ":" + month;
  const current = parseInt(await env.KV_NAMESPACE.get(usageKey) || "0");
  await env.KV_NAMESPACE.put(usageKey, (current + 1).toString(), { expirationTtl: 35 * 24 * 3600 });
}
__name(incrementUserUsage, "incrementUserUsage");
async function updateUserPlan(userId, planType, env) {
  if (!env.KV_NAMESPACE) return;
  const planKey = KV_KEYS.USER_PLAN + userId;
  await env.KV_NAMESPACE.put(planKey, planType);
}
__name(updateUserPlan, "updateUserPlan");
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
        return new Response(JSON.stringify({ success: true, result: "\u8FDE\u63A5\u6210\u529F", remaining: quota.remaining }), {
          headers: { "Content-Type": "application/json", ...getCorsHeaders(origin) }
        });
      }
      return successResponse("\u8FDE\u63A5\u6210\u529F", origin);
    }
    const clientIP = request.headers.get("CF-Connecting-IP") || "";
    if (!await checkRateLimit(clientIP, env, origin)) {
      return errorResponse("\u4ECA\u65E5\u8C03\u7528\u6B21\u6570\u5DF2\u8FBE\u4E0A\u9650\uFF08100\u6B21\uFF09", 429, origin);
    }
    if (!action || !["optimize-resume", "interview-feedback"].includes(action)) {
      return errorResponse("\u65E0\u6548\u7684 action", 400, origin);
    }
    if (action === "optimize-resume" && (!data?.resume || !data?.jobTarget)) {
      return errorResponse("\u7F3A\u5C11 resume \u6216 jobTarget", 400, origin);
    }
    if (action === "interview-feedback" && (!data?.question || !data?.answer || !data?.job)) {
      return errorResponse("\u7F3A\u5C11 question/answer/job", 400, origin);
    }
    const userId = data?.userId;
    if (!userId) return errorResponse("\u7F3A\u5C11\u7528\u6237\u6807\u8BC6 userId", 400, origin);
    const quotaCheck = await checkUserQuota(userId, env);
    if (!quotaCheck.allowed) return errorResponse(quotaCheck.reason, 403, origin);
    const remaining = quotaCheck.remaining;
    let systemPrompt = "", userPrompt = "";
    if (action === "optimize-resume") {
      systemPrompt = `\u4F60\u662F\u4E00\u4F4D\u8D44\u6DF1\u7684\u7B80\u5386\u4F18\u5316\u4E13\u5BB6\u3002\u8BF7\u6839\u636E\u76EE\u6807\u5C97\u4F4D\u4F18\u5316\u7B80\u5386\uFF0C\u8981\u6C42\uFF1A
1. \u4F7F\u7528\u91CF\u5316\u8868\u8FBE\uFF08\u7528\u5177\u4F53\u6570\u5B57\u7A81\u51FA\u4E1A\u7EE9\uFF09
2. \u4F7F\u7528\u4E3B\u52A8\u8BED\u6001\u548C\u5F3A\u52A8\u8BCD\uFF08\u5982"\u4E3B\u5BFC"\u3001"\u8D1F\u8D23"\u3001"\u5B9E\u73B0"\uFF09
3. \u4FDD\u6301\u771F\u5B9E\uFF0C\u4E0D\u7F16\u9020\u7ECF\u5386
4. \u53EF\u4EE5\u7528\u661F\u53F7(*)\u6807\u6CE8\u91CD\u70B9\u5185\u5BB9\uFF0C\u8BA9\u7528\u6237\u4E00\u76EE\u4E86\u7136
5. \u8FD4\u56DE\u683C\u5F0F\uFF1A\u4F18\u5316\u540E\u7684\u5B8C\u6574\u7B80\u5386\uFF0C\u6BB5\u843D\u6E05\u6670`;
      userPrompt = `\u76EE\u6807\u5C97\u4F4D\uFF1A${data.jobTarget}

\u539F\u59CB\u7B80\u5386\uFF1A
${data.resume}`;
    } else {
      systemPrompt = `\u4F60\u662F\u4E00\u4F4D\u4E13\u4E1A\u7684${data.job}\u9762\u8BD5\u5B98\u3002\u8BF7\u5BF9\u9762\u8BD5\u8005\u7684\u56DE\u7B54\u8FDB\u884C\u70B9\u8BC4\uFF0C\u8981\u6C42\uFF1A
1. \u6307\u51FA\u56DE\u7B54\u7684\u4F18\u70B9
2. \u6307\u51FA\u4E0D\u8DB3\u4E4B\u5904
3. \u63D0\u4F9B\u66F4\u597D\u7684\u56DE\u7B54\u601D\u8DEF\u6216\u5EFA\u8BAE
4. \u53EF\u4EE5\u7528\u661F\u53F7(*)\u6807\u6CE8\u91CD\u70B9\u5EFA\u8BAE
5. \u8FD4\u56DE\u683C\u5F0F\uFF1A\u6BB5\u843D\u6E05\u6670\uFF0C\u4FBF\u4E8E\u9605\u8BFB`;
      userPrompt = `\u9762\u8BD5\u95EE\u9898\uFF1A${data.question}

\u9762\u8BD5\u8005\u56DE\u7B54\uFF1A${data.answer}`;
    }
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) return errorResponse("\u670D\u52A1\u5668\u914D\u7F6E\u9519\u8BEF\uFF1A\u672A\u8BBE\u7F6E API \u5BC6\u94A5", 500, origin);
    const deepseekResponse = await fetch(DEEPSEEK_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        temperature: 0.7,
        max_tokens: 3e3,
        stream: false
      })
    });
    if (!deepseekResponse.ok) {
      const errorData = await deepseekResponse.json();
      console.error("DeepSeek API \u9519\u8BEF:", errorData);
      return errorResponse(`AI \u670D\u52A1\u8C03\u7528\u5931\u8D25: ${deepseekResponse.status}`, 502, origin);
    }
    const result = await deepseekResponse.json();
    const aiMessage = result.choices[0].message.content;
    if (env.KV_NAMESPACE) {
      const logKey = `log:${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}`;
      const currentLog = await env.KV_NAMESPACE.get(logKey) || "0";
      await env.KV_NAMESPACE.put(logKey, (parseInt(currentLog) + 1).toString());
    }
    incrementUserUsage(userId, env).catch((e) => console.error("\u589E\u91CF\u8BB0\u5F55\u5931\u8D25:", e));
    return successResponse(aiMessage, origin, { remaining });
  } catch (error) {
    console.error("Worker \u5185\u90E8\u9519\u8BEF:", error);
    return errorResponse("\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF", 500, origin);
  }
}
__name(handleAIAssistant, "handleAIAssistant");
async function handleUpgradePlan(request, env, ctx) {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });
  try {
    const body = await request.json();
    const { userId, planType, receipt } = body;
    if (!userId || !planType) return errorResponse("\u7F3A\u5C11 userId \u6216 planType", 400, origin);
    console.log("\u6536\u5230\u5347\u7EA7\u8BF7\u6C42", { userId, planType, receipt });
    await updateUserPlan(userId, planType, env);
    return successResponse({ message: "\u5957\u9910\u5347\u7EA7\u6210\u529F" }, origin);
  } catch (error) {
    console.error("\u5347\u7EA7\u5957\u9910\u9519\u8BEF:", error);
    return errorResponse("\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF", 500, origin);
  }
}
__name(handleUpgradePlan, "handleUpgradePlan");
var index_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (url.pathname === "/api/hello") {
      return new Response(JSON.stringify({ message: "Hello", status: "success" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }
    if (url.pathname === "/api/ai-assistant") {
      return handleAIAssistant(request, env, ctx);
    }
    if (url.pathname === "/api/upgrade-plan" && request.method === "POST") {
      return handleUpgradePlan(request, env, ctx);
    }
    if (url.pathname === "/") {
      return new Response("Welcome to AI Job Assistant API!", { headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Not Found", { status: 404 });
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map

