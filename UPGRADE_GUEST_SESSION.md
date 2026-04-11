# Guest Session Token 升级方案 — aistudio_stream

## 背景

前端所有请求已携带 `X-Session-Token` 头。  
Stream 服务需要：**透传 session_token 给 Backend，允许无 Authorization 的 guest 请求通过，SSE 事件按 session_token 过滤。**

---

## 改动清单（按执行顺序）

### 第一步：conversations.ts — 透传 X-Session-Token + 允许无 Authorization

**文件**: `src/routes/conversations.ts`

#### 1.1 移除无 token 时的 401 早返回

当前逻辑：

```typescript
const authHeader = request.headers['authorization'];
if (!authHeader) {
  reply.status(401).send({ message: 'Unauthorized' });
  return;
}
```

改为：

```typescript
const authHeader = request.headers['authorization'] as string | undefined;
const sessionToken = request.headers['x-session-token'] as string | undefined;

// 无 Authorization 且 无 X-Session-Token → 401
if (!authHeader && !sessionToken) {
  reply.status(401).send({ message: 'Unauthorized' });
  return;
}
```

#### 1.2 转发到 Backend 时带 X-Session-Token

构建转发 headers 时增加：

```typescript
const forwardHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Internal-Token': config.INTERNAL_TOKEN,
};
if (authHeader) forwardHeaders['Authorization'] = authHeader;

const tenantId = request.headers['x-tenant-id'];
if (tenantId) forwardHeaders['X-Tenant-ID'] = String(tenantId);

// ✅ 新增：透传 session token
if (sessionToken) forwardHeaders['X-Session-Token'] = String(sessionToken);
```

---

### 第二步：tasks.ts — SSE 事件按 session_token 过滤

**文件**: `src/routes/tasks.ts`

#### 2.1 auth/verify 返回 session_token

Backend 的 `/api/internal/auth/verify` 升级后会返回 `{ user_id, session_token?, is_guest? }`。  
Stream 需要保存这些信息：

```typescript
// 验证 token 后
const verifyData = await verifyResponse.json() as {
  user_id: number;
  session_token?: string;
  is_guest?: boolean;
};

const currentUserId = verifyData.user_id;
const currentSessionToken = verifyData.session_token ?? null;
const isGuest = verifyData.is_guest ?? false;
```

#### 2.2 Redis 事件过滤增加 session_token

当前过滤逻辑：

```typescript
if (data.user_id === currentUserId) {
  // push event
}
```

改为：

```typescript
if (data.user_id === currentUserId) {
  // Guest 用户需要额外匹配 session_token
  if (isGuest && data.session_token && data.session_token !== currentSessionToken) {
    continue; // 跳过其他 guest 的事件
  }
  // push event
}
```

#### 2.3 connected 事件带 session_token

```typescript
// SSE connected 事件
res.write(`event: connected\ndata: ${JSON.stringify({
  user_id: currentUserId,
  session_token: currentSessionToken,  // ← 新增
})}\n\n`);
```

---

### 第三步：Backend auth/verify 升级配合

> 此步骤在 aistudio_backend 侧实现，这里说明 Stream 的依赖。

Backend `POST /api/internal/auth/verify` 当前只返回 `{ user_id }`。  
升级后需返回：

```json
{
  "user_id": 12345,
  "session_token": "uuid-string-or-null",
  "is_guest": false
}
```

对于 stream-token 的生成（`POST /api/v1/stream-token`），如果请求来自 guest 用户，  
需要在 Cache 中同时存入 session_token：

```php
// Backend: POST /api/v1/stream-token
$streamToken = Str::random(64);
Cache::put("stream-token:{$streamToken}", [
    'user_id' => $user->user_id,
    'session_token' => $request->attributes->get('session_token'),
    'is_guest' => $request->attributes->get('is_guest', false),
], now()->addMinutes(5));
```

对应 auth/verify 返回完整结构：

```php
// Backend: POST /api/internal/auth/verify
$data = Cache::get('stream-token:'.$token);
if (is_array($data)) {
    return response()->json($data);  // { user_id, session_token, is_guest }
} elseif (is_numeric($data)) {
    // 兼容旧格式
    return response()->json(['user_id' => (int) $data]);
}
```

---

## 完整改动文件列表

| 文件 | 改动内容 |
|------|----------|
| `src/routes/conversations.ts` | 允许无 Authorization 但有 X-Session-Token 的请求；透传 X-Session-Token 到 backend |
| `src/routes/tasks.ts` | SSE 订阅时解析 session_token；Redis 事件过滤增加 session_token 匹配 |

---

## 验证步骤

```bash
# 1. 测试无 Authorization 的流式请求（需要 backend 先完成升级）
curl -X POST http://localhost:3100/api/conversations \
  -H "Content-Type: application/json" \
  -H "X-Tenant-ID: 1" \
  -H "X-Session-Token: test-uuid-1234" \
  -d '{"agent_id": 123, "message": "你好"}'
# 预期: SSE 流正常返回 connected + token + done 事件

# 2. 测试有 Authorization 的请求（兼容性）
curl -X POST http://localhost:3100/api/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {real_token}" \
  -H "X-Tenant-ID: 1" \
  -H "X-Session-Token: test-uuid-1234" \
  -d '{"agent_id": 123, "message": "你好"}'
# 预期: 正常工作，与之前行为一致

# 3. 测试 SSE 订阅隔离
# 两个不同 session_token 的 guest 用户应该只收到各自的事件
```

---

## 依赖关系

```
aistudio_backend 升级（先）
    ├── Guest 用户 seed
    ├── session_token 列迁移
    ├── AuthenticateApi 中间件
    ├── stream-token Cache 格式升级
    └── auth/verify 返回格式升级
         │
         ▼
aistudio_stream 升级（后）
    ├── conversations.ts 透传
    └── tasks.ts SSE 过滤
```

**建议先完成 backend 升级并验证 guest API 调用正常，再升级 stream。**
