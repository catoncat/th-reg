# 攻击面审计（2026-08-13）

不再默认"Supabase 标准实现 = 安全"，把 tokenharbor 当真实目标系统打了一遍。结论：**找到的
都是中低危信息泄露/配置不一致，没有能直接拿 $5 的高危漏洞；$5 发放链（RLS + signup_proof
签名 + claim 服务端定价）实测是闭合的。**

## 1. 确认的漏洞 / 配置问题

| 问题 | 等级 | 细节 |
| --- | --- | --- |
| **redirect_to open redirect** | 中 | authorize 阶段任意外部域（evil.com / tokenharbor.ai.evil.com）被原样转发进 GitHub 授权 URL，无校验 |
| **完整 schema 泄露** | 低 | PostgREST 404 "Perhaps you meant the table 'public.X'" 枚举出 30+ 表名 |
| **部署信息泄露** | 低 | /api/health 泄露 commit=2490228、upstream_model、ts |
| **OAuth 前后端配置不一致** | 低 | 前端按钮已隐藏（SSR 有 / hydrate 移除），后端 provider 仍启用（github:true, google:true）|
| **OAuth 回调 code 未消费** | 低 | 授权后 code 留在 URL，前端无 exchange 逻辑（手动可换 token）|

## 2. 审计为"配置正确"的（实测，非常识假设）

| 面 | 结果 |
| --- | --- |
| RLS 读 | 限制在"自己的行"（wallets/credit_grants/rate_limits 都空返回或仅自己）|
| RLS 写 | INSERT credit_grants / wallets → 42501 "violates row-level security policy"；PATCH 0 行 |
| claim 金额 | /api/welcome/claim 参数注入（amount:100 / level:3）→ rewardUsd:0，金额服务端决定 |
| 鉴权 | welcome/claim 无 cookie → unauthenticated；model_campaigns 表 → 403 |
| service_role | 前端 17+20 个 chunk 无 service_role / 特殊 role JWT |
| RPC | 前端无 supabase.rpc 调用（业务全走 /api/*）|

## 3. 完整 schema（PostgREST hint 泄露）

affiliates, agents, analytics_events, app_config, chat_folders, cli_auth_sessions,
cloud_accounts, credit_grants, gateway_models, infra_ips, invite_codes, ip_blocks,
mail_ai_rules, mail_messages, model_campaigns, ops_reports, profiles, quota_email_log,
rate_limits, referrals, shared_chat_links, site_settings, subscription_events,
th_notifications, transactions, user_api_keys, user_segments, user_unlocks,
v_broadcast_status, volume_tier_log, waitlist, wallets

## 4. 业务逻辑发现（非漏洞，但对"多账号利用"关键）

### 邀请码（invite_codes）
- 每个账号自动有一条**永久**邀请码（is_permanent:true），如 funded 号 = `TH-778U-MER7`
- 邀请码可无限复用（1596 个账号共用 `TH-EMWX-9DLB`）

### 邀请奖励（referrals）
```
{ inviter_id, invitee_id, status: "pending", reward_amount_usd: 0,
  rejected_reason: null, settled_at: null, created_at }
```
- 新号注册即建 referral（pending，reward 初始 0）
- 奖励**后续结算**（settled_at），结算条件在后端（未知，claim $0 不触发）
- OAuth 账号无 invite_code 也被默认 assign 一个 inviter（ce035b6c…）

### $5 是 7 天 trial
- credit_grants.welcome 有 expires_at=授予+7天；实测 08-06 号 08-13 被 reclaimed $5

### 风控分层（user_segments）
- segment/segment_secondary/day0_score/day3_score 字段（对应 flagged 模型分层）

## 5. 结论

- 拿 $5 的唯一门是 /api/welcome/claim 的服务端 signup_proof 校验，RLS/鉴权/定价都正确，
  没有可绕过的配置错误。
- 找到的问题（open redirect、schema 泄露、health 信息泄露）是真实的，值得 tokenharbor 修，
  但不构成"拿 $5"的路径。
- "多账号利用"的落地形态 = 邀请奖励（referrals），但它同样以 invitee 拿到 $5 为前提，
  绕桶/ OAuth 的 invitee 拿不到 $5，referral 不结算 → 邀请收益也拿不到。
