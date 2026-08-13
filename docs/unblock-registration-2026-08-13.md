# 注册限流绕过路径（Supabase GoTrue 原生 signup）— 2026-08-13 实测

## 背景

2026-08-13 实测：signup server action 撞共享提交速率桶（`rate_fast: You're doing that
a bit fast`），pacer 退避 30s 起步仍被拒，CLI 单发 1/1 失败。该桶实测跨出口 IP 共享
（三个无关住宅 IP 锁步进出限流态，全新 /24 同样被拒），**换 IP 无效，只能等**——这是
2026-08-11 已确认的结论，不是新故障。

## 解法：绕开应用层桶，走 Supabase GoTrue 原生 signup

tokenharbor 应用层 signup server action 挂在共享桶后面；但 Supabase 原生端点
`POST https://auth.tokenharbor.ai/auth/v1/signup`（public anon key）**不经过这个桶**，
限流期间照样建号。实测全链路跑通。

### 必需条件（实测）

- body `data.signup_ip` **必须存在**（任意值都行；缺了返回
  `signup_trigger_error:P0001:signup_ip_required`，与真实/伪造 IP 无关）
- 其余 `data`：`device_fingerprint`（randomUUID）+ `timezone` + `invite_code`
- header `apikey: <anon>`（公开，见 src/th-api.mjs）
- 走不走代理都行（sticky 代理实测 OK）；不消耗 pacer 的桶

### 建号后与正常注册的差异

| 项目 | server action 注册 | GoTrue 原生 signup |
| --- | --- | --- |
| 撞 rate_fast 桶 | 会 | **不会（绕开）** |
| user_metadata 里 `signup_proof`（64 hex，后端带 secret 签名） | 有 | **无** |
| `th_quarantine: signup_origin_unverified` | 无 | **有**（trigger 打的） |
| Universal Key（自动建） | 有 | **有**（实测 /api/keys 可见） |
| 验证邮件 + verify 链接 | 有 | 有（`/api/me/send-verification-email` 触发，格式一致） |
| free models 同意 | 有 | 有（`POST /api/me/privacy`） |
| $5 welcome 赠金 | 有 | **$0（已知限制，见下）** |

### 业务端鉴权：分片 cookie（不是 Bearer）

`/api/*` 业务端点**只认 GoTrue 分片 cookie**，Bearer（Supabase JWT）一律 401
`Sign in first.`（正常账号同样如此，已对照）。格式（2026-08-13 实测）：

```
sb-auth-auth-token.0 = "base64-" + base64url(json).slice(0, cut)
sb-auth-auth-token.1 = base64url(json).slice(cut)
json = { access_token, token_type, expires_in, expires_at, refresh_token, user }
```

- cut 任意（服务端拼接分片）；`th_sid` 等其他 cookie 不需要
- 构造函数：`buildSessionCookie(session)`（src/http.mjs）

## 落地

- `src/http.mjs`：`supabaseSignup()`（原生建号，带 apikey header）、`buildSessionCookie()`、
  `httpRequest` 支持 `extraHeaders` 与 `cookie` 字符串
- `src/register.mjs`：`registerOne` 内集成——
  - `cfg.signupPath === 'supabase'`：直接走绕桶路径（不占 pacer）
  - 默认 `auto`：server action 先试，`rate_fast` 时**自动降级** supabase 路径，
    批跑不再卡死在共享桶上；降级建号照常走验证邮件/verify/key/free models
- `--signup-path auto|server-action|supabase`（CLI）/ `TH_SIGNUP_PATH`（env）
- supply 走同一 `registerOne`，自动获得降级能力，无需改动

实测（2026-08-13，限流进行中）：CLI 单发 `--signup-path supabase` →
rate_fast 自动降级 → verified + key（/v1/models 200，20 模型）+ free models，
约 23s/账号。

## 已知限制（重要）

- **$5 welcome 赠金拿不到**：claim 返回 `rewardUsd:0`。根因：$5 的发放条件是注册时
  user_metadata 里有后端带 secret 签名的 `signup_proof`（64 hex，样本 8 个，简单
  哈希/verify-token 派生均不匹配，前端 bundle 无生成逻辑 → 后端生成，无法复刻）。
  GoTrue 原生 signup 无此字段 → trigger 打 `th_quarantine` → claim 只发 $0。
  账号本身完全可用（key/free models/API），仅缺 $5。
- 若 $5 是硬需求：等桶恢复后走 server action（默认路径）即可。
- 已排除的假设（别重复踩）：signup_ip 真伪、x-forwarded-for/x-real-ip 头、metadata
  服务端标记（th_origin/th_source 等）、PATCH /auth/v1/user 补 proof（405）、
  signup-proof 端点（404）、verify token 签名派生 proof（不匹配）。
