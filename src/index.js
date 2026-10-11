// ==================== 常量定义 ====================
const PLAN_LIMITS = {
    "free": 5,
    "monthly": 100,
    "quarterly": 300,
    "yearly": 1200,
    "token30": 30
};

const KV_KEYS = {
    USER_PLAN: "user:plan:",
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

function getCurrentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

// 产品 ID → 套餐类型映射（注意完整 ID）
function mapProductIdToPlan(productId) {
    if (productId === "com.apheriai.aijob.monthly") return "monthly";
    if (productId === "com.apheriai.aijob.quarterly") return "quarterly";
    if (productId === "com.apheriai.aijob.yearly") return "yearly";
    if (productId === "com.apheriai.aijob.token30") return "token30";
    return null;
}

// 检查用户配额
async function checkUserQuota(userId, env) {
    if (!env.KV_NAMESPACE) return { allowed: true, remaining: 999 };
    const month = getCurrentMonth();
    const planKey = KV_KEYS.USER_PLAN + userId;
    const usageKey = KV_KEYS.USER_USAGE + userId + ":" + month;

    let plan = await env.KV_NAMESPACE.get(planKey) || "free";
    let used = parseInt(await env.KV_NAMESPACE.get(usageKey) || "0");
    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const remaining = limit - used;

    if (remaining <= 0) return { allowed: false, reason: "当月次数已用完，请升级套餐或下月再来" };
    return { allowed: true, remaining, plan, used, limit };
}

async function incrementUserUsage(userId, env) {
    if (!env.KV_NAMESPACE) return;
    const month = getCurrentMonth();
    const usageKey = KV_KEYS.USER_USAGE + userId + ":" + month;
    const current = parseInt(await env.KV_NAMESPACE.get(usageKey) || "0");
    await env.KV_NAMESPACE.put(usageKey, (current + 1).toString(), { expirationTtl: 35 * 24 * 3600 });
}

async function updateUserPlan(userId, planType, env) {
    if (!env.KV_NAMESPACE) return;
    const planKey = KV_KEYS.USER_PLAN + userId;
    await env.KV_NAMESPACE.put(planKey, planType);
}

// 应用套餐权益（订阅型重置当月用量；token30 累加到独立余额）
async function applyPlan(userId, planType, env) {
    await updateUserPlan(userId, planType, env);
    if (planType !== "token30") {
        const month = getCurrentMonth();
        const usageKey = KV_KEYS.USER_USAGE + userId + ":" + month;
        await env.KV_NAMESPACE.put(usageKey, "0");
    }
}

// ==================== 苹果收据验证（核心） ====================
async function verifyAppleReceipt(receipt, env) {
    const sharedSecret = env.APPLE_SHARED_SECRET || null;
    const payload = { "receipt-data": receipt };
    if (sharedSecret) payload.password = sharedSecret;

    // 1. 先向生产环境验证
    let verifyRes = await fetch("https://buy.itunes.apple.com/verifyReceipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    let verifyResult = await verifyRes.json();

    // 2. 状态码 21007 表示这是沙盒收据，改用沙盒验证
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


// ==================== 纯原生生成 Apple JWT ====================

// Base64URL 编码辅助函数
function base64urlEncode(str) {
    return btoa(str)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Base64URL 转 Uint8Array 辅助函数
function base64urlToUint8Array(base64url) {
    const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return new Uint8Array([...rawData].map(char => char.charCodeAt(0)));
}

// 生成 Apple 服务端 API 的 JWT
async function generateAppleJWT(env) {
    const header = { alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: env.APPLE_ISSUER_ID,
        iat: now,
        exp: now + 300,
        aud: 'appstoreconnect-v1'
    };

    const encodedHeader = base64urlEncode(JSON.stringify(header));
    const encodedPayload = base64urlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    // 处理私钥：去掉头尾和换行符
    const privateKeyBase64 = env.APPLE_PRIVATE_KEY
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s+/g, ''); 

    const privateKeyBuffer = base64urlToUint8Array(privateKeyBase64);

    // 导入私钥
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        privateKeyBuffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
    );

    // 使用 ECDSA SHA-256 签名
    const signatureBuffer = await crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        privateKey,
        new TextEncoder().encode(unsignedToken)
    );

    const signatureBase64 = base64urlEncode(
        String.fromCharCode(...new Uint8Array(signatureBuffer))
    );

    return `${unsignedToken}.${signatureBase64}`;
}

// 调用 App Store Server API 查询交易
async function getTransactionInfo(transactionId, env, environment = 'production') {
    const jwt = await generateAppleJWT(env);
    const baseUrl = environment === 'sandbox'
        ? 'https://api.storekit-sandbox.itunes.apple.com'
        : 'https://api.storekit.itunes.apple.com';

    const res = await fetch(
        `${baseUrl}/inApps/v1/transactions/${transactionId}`,
        { headers: { 'Authorization': `Bearer ${jwt}` } }
    );

    if (!res.ok) {
        const errText = await res.text();
        console.error('App Store Server API 错误:', res.status, errText);
        if (environment === 'production') {
            // 生产环境查不到，尝试沙盒
            return getTransactionInfo(transactionId, env, 'sandbox');
        }
        return null;
    }
    return res.json();
}

// 从 JWS 中解码交易信息
function decodeJWSPayload(jws) {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload;
}

// ==================== 验证收据（新增，修复支付回调） ====================
async function handleVerifyReceipt(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });
    if (request.method !== "POST") return errorResponse("Method not allowed", 405, origin);

    try {
        const body = await request.json();
        const { transactionId, productId, userId } = body;

        if (!transactionId || !userId) {
            return errorResponse("缺少 transactionId 或 userId", 400, origin);
        }

        console.log("验证交易:", { transactionId, productId, userId });

        // 1. 调用 App Store Server API 查询交易
        const txResponse = await getTransactionInfo(transactionId, env);
        if (!txResponse || !txResponse.signedTransactionInfo) {
            return errorResponse("无法获取交易信息", 400, origin);
        }

        // 2. 解码 JWS，获取交易详情
        const txPayload = decodeJWSPayload(txResponse.signedTransactionInfo);
        if (!txPayload) {
            return errorResponse("交易信息解码失败", 400, origin);
        }

        console.log("交易详情:", JSON.stringify(txPayload));

        // 3. 校验 productId
        const realProductId = txPayload.productId;
        if (productId && realProductId !== productId) {
            console.warn("产品ID不匹配，前端:", productId, "苹果:", realProductId);
        }

        // 4. 映射套餐类型
        const planType = mapProductIdToPlan(realProductId);
        if (!planType) {
            return errorResponse("未知的产品ID: " + realProductId, 400, origin);
        }

        // 5. 应用套餐
        await applyPlan(userId, planType, env);
        console.log("套餐已应用:", userId, planType);

        const finalQuota = await checkUserQuota(userId, env);
        return successResponse(
            { message: "验证成功", plan: planType },
            origin,
            { remaining: finalQuota.remaining }
        );

    } catch (error) {
        console.error("验证交易失败:", error);
        return errorResponse("服务器处理失败", 500, origin);
    }
}

// ==================== 升级套餐处理（保留，需注意安全） ====================
async function handleUpgradePlan(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });

    try {
        const body = await request.json();
        const { userId, planType, receipt } = body;

        if (!userId || !planType) return errorResponse("缺少 userId 或 planType", 400, origin);

        // 如果有 receipt，则进行验证
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

// ==================== 恢复购买处理 ====================
async function handleRestorePurchases(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { headers: getCorsHeaders(origin) });

    try {
        const body = await request.json();
        const { userId, transactions } = body;

        if (!userId || !transactions || !Array.isArray(transactions) || transactions.length === 0) {
            return errorResponse("缺少 userId 或 transactions 数组", 400, origin);
        }

        let anySuccess = false;
        const results = [];

        for (const tx of transactions) {
            try {
                const txResponse = await getTransactionInfo(tx.transactionId, env);
                if (txResponse && txResponse.signedTransactionInfo) {
                    const txPayload = decodeJWSPayload(txResponse.signedTransactionInfo);
                    const planType = mapProductIdToPlan(txPayload.productId);
                    if (planType) {
                        await applyPlan(userId, planType, env);
                        anySuccess = true;
                        results.push({ transactionId: tx.transactionId, success: true });
                    }
                }
            } catch (e) {
                console.error("恢复交易失败:", tx.transactionId, e);
                results.push({ transactionId: tx.transactionId, success: false });
            }
        }

        if (anySuccess) {
            const finalQuota = await checkUserQuota(userId, env);
            return successResponse(
                { message: "恢复成功", results },
                origin,
                { remaining: finalQuota.remaining }
            );
        } else {
            return errorResponse("没有找到有效的恢复购买记录", 404, origin);
        }

    } catch (error) {
        console.error("恢复购买处理失败:", error);
        return errorResponse("服务器处理失败", 500, origin);
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

        if (url.pathname === "/api/ai-assistant") {
            return handleAIAssistant(request, env, ctx);
        }

        if (url.pathname === "/api/verify-receipt") {
            return handleVerifyReceipt(request, env, ctx);
        }

        if (url.pathname === "/api/upgrade-plan") {
            return handleUpgradePlan(request, env, ctx);
        }

        if (url.pathname === "/api/restore-purchases") {
            return handleRestorePurchases(request, env, ctx);
        }

        if (url.pathname === "/") {
            return new Response("Welcome to AI Job Assistant API!", {
                headers: { "Content-Type": "text/plain" }
            });
        }

        return new Response("Not Found", { status: 404 });
    }
};
