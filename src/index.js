export default {
  async fetch(request, env, ctx) {
    // 解析请求的 URL
    const url = new URL(request.url);
    
    // 简单的路由示例
    if (url.pathname === '/api/hello') {
      // 返回一个 JSON 响应，这正是 App 需要的
      return new Response(JSON.stringify({ 
        message: 'Hello from your first Worker!',
        status: 'success'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 如果是访问根目录，返回一些提示信息
    if (url.pathname === '/') {
      return new Response('Welcome to my Worker! Try /api/hello', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    // 其他路径返回 404
    return new Response('Not Found', { status: 404 });
  },
};
