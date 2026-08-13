# OAuth 横向探索（2026-08-13）

## 结论一句话

**OAuth（Google/GitHub）注册能绕过 rate_fast 桶，但拿不到 $5**——business 侧完全不初始化
（无 wallet、无 key、claim 报 email_not_verified），$5 依然只属于 server action email 注册。

## 1. OAuth 跳转链（GitHub 实测）

```
[1] 发起（手动构造，带 PKCE）:
    https://auth.tokenharbor.ai/auth/v1/authorize
      ?provider=github
      &code_challenge=<S256(challenge)>
      &code_challenge_method=S256
    → 302（不带 state 时，服务端签发 UUID state）

[2] GitHub 授权页:
    https://github.com/login/oauth/authorize
      ?client_id=Ov23linsQdVvZJSnzkEe            ← tokenharbor 的 GitHub OAuth App
      &redirect_uri=https://auth.tokenharbor.ai/auth/v1/callback
      &response_type=code
      &scope=user:email
      &state=<服务端签发的 UUID>
    （多账号时先 select_account，已登录账号 skip_account_picker=true）

[3] 用户授权 → GitHub 回跳:
    https://auth.tokenharbor.ai/auth/v1/callback?code=<code>&state=<UUID>

[4] auth 域 callback 校验 state 后 302 回 app 域:
    https://tokenharbor.ai/?code=<code>          ← code 留在 URL 未被消费！

[5] 纯协议换 token:
    POST https://auth.tokenharbor.ai/auth/v1/token?grant_type=pkce
    body: { auth_code, code_verifier } → 返回 access_token + user
```

## 2. 配置审计发现

| 项 | 状态 | 说明 |
| --- | --- | --- |
| **redirect_to 校验** | ❌ **不校验** | authorize 阶段任意外部域（evil.com / tokenharbor.ai.evil.com）被原样转发进 GitHub 授权 URL → open redirect 信号 |
| state 校验 | ✅ 有 | 带自定义 state → `bad_oauth_state`；不带则服务端签发 UUID（服务端存储） |
| OAuth 前端按钮 | ⚠️ **已隐藏** | SSR HTML 有 "Continue with Google/GitHub" 按钮，但客户端 hydration 后移除 |
| 后端 provider | ✅ 仍启用 | /auth/v1/settings: github:true, google:true（apple/twitter/discord 等全 false）|
| 前端 code 消费逻辑 | ❌ 已移除 | 回调后 code 留在 URL 没人消费（因按钮隐藏 + 无 exchange 逻辑）|
| disable_signup | false | Supabase 层 signup 开放（限流是 tokenharbor 应用层）|
| mailer_autoconfirm | true | 邮箱自动 confirm（≠ business 侧验证）|

## 3. OAuth 注册账号状态（实测 catoncat → git@chen.rs）

- user_metadata：纯 OAuth 字段（avatar_url/email/full_name/iss/preferred_username/...）
  **无 signup_proof、无 invite_code、无 th_quarantine**
- wallets：**空**（无 wallet 记录）
- credit_grants：**空**（无 $5）
- /api/gifts/status：`{"claimable":[]}`
- /api/keys：`keys_fetch_failed`（无 Universal Key）
- /api/welcome/claim：`email_not_verified`（business 侧不认 Supabase email_verified:true，已触发发验证邮件）

## 4. 多账号利用发现

- **$5 是 7 天 trial**：credit_grants.welcome 有 expires_at=授予+7天，过期后 reclaimed_at 回收
  （实测 08-06 注册的 funded 号，08-13 被 reclaimed $5）
- **signup_proof 是后来引入的防绕过**：08-06 早期账号无 signup_proof 但有 $5
- 邀请/referral 无独立 API（/api/invite、/api/referral、/api/me/invite* 全 404）
- 早期 welcome grant kind=welcome, amount_usd=5, meta.reason=welcome_signup

## 5. 横向总结论

$5 的发放链路是**渐进收紧**的：早期 server action 直接发 $5（无 proof），后来引入
signup_proof（带 secret 签名）+ th_quarantine 防绕过，堵死 GoTrue 原生 signup 和 OAuth。
现在唯一能拿 $5 的路径 = server action email 注册（被 rate_fast 桶限流）。

**所有旁路（GoTrue 原生 / OAuth）都只能建号，拿不到 $5。**
