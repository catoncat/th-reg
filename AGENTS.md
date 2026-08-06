# AGENTS.md — Token Harbor 注册机（唯一权威文档）

**新对话只读本文件 + live 状态即可接手。** 冲突优先级：用户当前会话要求 > 本文件 > 任何旧探索记录。

## 0. 一句话架构

```
cloud-mail catch-all 随机邮箱（多域名池）
  → agent-browser（CDP 驱动 Chrome）走 DataImpulse 住宅 sticky 代理
  → tokenharbor.ai 注册（React 19 server action，浏览器提交）
  → cloud-mail 收验证邮件 → 浏览器开 verify 链接激活
  → dashboard 自动 claim $5 gift + enable free models + 创建 API key
  → 产出存 data/accounts.jsonl（email/password/api_key/balance/gift/invite_code）
```

## 1. 当前状态（2026-08-06 实测全绿）

完整流程已跑通，单账号实测日志：

```
[+] account created   (dashboard body 检测)
[+] email verified    -> /dashboard?verify=success
[+] $5 gift claimed   -> balance $5.00
[+] free models enabled
[+] API key created   -> thk_live_6Mmm...（完整值已存 accounts.jsonl）
status=verified, invite_code=TH-EMWX-9DLB
```

**进行中的任务（用户 2026-08-06 提的，未做，接手先做这两个）：**
1. **邮箱多域名池轮换**：不要都用 `dogfood.0day3.com`，要「多个子域名 + 母域名」搭配。可用池见 §5。
2. **用户名去 bot 化**：当前是 `th-<hex>@` 明显规律，要改成真实风格（如 `emma.chen92`、`liam.walker.dev`、可读随机词），避免统一前缀/连续 hex。

## 2. 硬规则

1. **`registerOne` 必须 close 浏览器会话**（try/finally）。历史 bug：跑完不关，每号泄漏一个 Chrome 实例把机器拖卡。已修，勿回退。
2. **纯协议（curl）复现注册不可行，勿再试**：React 19 server action 的 `$ACTION_REF_1`/`$ACTION_KEY` 由客户端加密，实测 curl POST 返回 HTTP 500 `digest 182133037`。注册提交只能浏览器。
3. **不绕过验证码**：`signup-precheck` 返回 `needCaptcha:true`（Turnstile）时，账号标记 `captcha-required` 跳过，不强制。
4. **每账号独立 sticky 代理 sessid + 独立 agent-browser session**，IP 不共享，降低风控关联。
5. **账号密码、API key 是机密**：`data/` 已 gitignore；本仓库是本地仓库，勿 push 公共远程。
6. **邮件只走 cloud-mail**（本机 intake，mail.0day3.com），不接其他邮件 provider。
7. **测活/调试别开一堆浏览器不收拾**；任何 agent-browser 会话用完 close。

## 3. 协议事实（live 验证，指导实现）

| 步骤 | 端点/动作 | 实测事实 |
| --- | --- | --- |
| 注册页 | `GET /login?mode=signup` | SSR 表单含 hidden `$ACTION_KEY`、`$ACTION_1:0`（action id `603c964e94bb382504398296ba0e0fb5e9c65df296`）、`device_fingerprint`、`timezone`、`invite_code` |
| 预检 | `GET /api/auth/signup-precheck?fp=<fp>` | 住宅 IP 下 `{needCaptcha:false}`；true 则要求 Turnstile（sitekey `0x4AAAAAADBuC8Knz1EJZx9-`） |
| 提交 | POST signup server action（multipart，React 19 加密字段 + email/password/invite_code） | 成功 → 账号创建（**API 未解锁**） |
| 验证邮件 | 来自 `verify@tokenharbor.ai` | "Verify your email to unlock API access"，24h 链接 `https://tokenharbor.ai/verify-email?token=<base64>` |
| 激活 | 浏览器开 verify 链接 | → `/dashboard?verify=success`（API 解锁） |
| gift | dashboard 点 "1 new gift to claim" → 弹层点 "Claim" | +$5.00，balance 变 $5.00 |
| free models | dashboard 点 "Enable free models" | DeepSeek V4 Flash / MiMo 2.5 / GPT-5.6 Luna |
| API key | `/dashboard/api-keys` → "+ New key" → 填 label → "Create key" | 完整 key 只在创建瞬间显示一次 |

**邀请码**：`TH-EMWX-9DLB`（第一个测试号生成，批量时所有新号复用它，给母号贡献邀请收益）。

## 4. 关键坑（调试经验，省得重踩）

- **React 19 server action 提交后 body 变 dashboard 但 `location.href 不更新`**（实测 URL 停在 `/login?mode=signup` 70s+，body 已是 dashboard）。**检测 dashboard 必须用 body 特征（`BALANCE`+`Overview`+`API Key`），不能用 URL 匹配**。`waitForUrl` 在这会永远超时。
- **提交用 `form.requestSubmit()`，不要只 click 按钮**：底部 cookie banner（"Essential only"/"Accept analytics"）会遮挡提交按钮导致 click 落空。代码已先关 banner 再 requestSubmit。
- **API key 前缀不固定**：实测有 `thk_live_A_...` 和 `thk_live_-...` 两种。抓取正则用 `thk_live_[A-Za-z0-9_-]{20,}`（排除 masked 的 `•`），别写死 `_A_`。
- **完整 API key 只显示一次**，创建后立即抓（在 `<code>` 元素），sleep 别太长。
- **agent-browser eval 输出是双重 JSON 转义**：`JSON.parse(JSON.parse(stdout))`，`Browser.eval` 已处理。
- **掉登录**：tokenharbor session 会过期；调试时若跳到 `login?next=...` 需重新 `requestSubmit` 登录。

## 5. 路径与资源

| 名称 | 路径 |
| --- | --- |
| 项目根 | `/Users/envvar/repo/work/tokenharbor-register` |
| 入口 | `src/cli.mjs`（`node src/cli.mjs --count N --invite-code CODE [--workers N] [--domain D]`） |
| 注册流程 | `src/register.mjs`（registerOne + postRegisterSetup） |
| 浏览器封装 | `src/browser.mjs`（agent-browser CLI，含 close） |
| 邮箱 | `src/mailbox.mjs`（cloud-mail CLI 子进程） |
| 配置 | `src/config.mjs` + `.env.local`（gitignored） |
| 产出 | `data/accounts.jsonl`（0600，gitignored） |
| cloud-mail 项目 | `/Users/envvar/repo/work/cloud-mail`（intake worker + CLI；域名池在 `apps/intake/config/domains.json`） |
| cloud-mail CLI | `/Users/envvar/bin/cloud-mail`（`messages --email <addr> --limit N`） |
| 代理密钥 | `~/.agents/skills/residential-proxy/.secrets/dataimpulse.env`（username `d527a1b1...`，0600） |

**代理**：DataImpulse 住宅。轮换 `http://user:pass@gw.dataimpulse.com:823`；sticky `http://user__<cc>;sessid.<id>:pass@gw.dataimpulse.com:<10000-20000>`。每账号一个 sessid。

**cloud-mail 域名池**（`apps/intake/config/domains.json`，均 catch-all 到 mail.0day3.com）：
- 母域名：`0day3.com` `kada.cam` `0pen.tech` `git-cl.one` `kada.pics` `link2.bond` `m0m.app` `only2.cyou` `runshan.cyou` `soul2.bond` `vvwvv.bond`（`r1.chat` 有业务含义，慎用）
- 子域名：`dogfood/pokeface/a1/b1/c1/reg/n/signup/mail2/grokmail.0day3.com`、`edu.watchdog.cyou`、`edu.z-skills.com`
- **选新域名前必须实测能收到 tokenharbor 验证邮件**（`cloud-mail messages --email test@<域>`）。

## 6. 命令

```bash
cd /Users/envvar/repo/work/tokenharbor-register

# 单账号（带邀请码）
node src/cli.mjs --count 1 --invite-code TH-EMWX-9DLB

# 批量
node src/cli.mjs --count 6 --workers 2 --invite-code TH-EMWX-9DLB

# 指定域名
node src/cli.mjs --count 2 --domain kada.cam --invite-code TH-EMWX-9DLB

# 看产出
tail -5 data/accounts.jsonl

# 验证某邮箱收件（cloud-mail）
cloud-mail messages --email <addr> --limit 5
```

## 7. 接管清单

新对话按此核对后再动手：

1. 已读本文件
2. `git -C /Users/envvar/repo/work/tokenharbor-register log --oneline -5` 看最近改动
3. `tail -5 data/accounts.jsonl` 看已产出账号（status/api_key/balance）
4. 确认无泄漏浏览器：`pgrep -fl "agent-browser-chrome" | wc -l` 应为 0（跑批时除外）
5. 代理预检：sticky endpoint curl ipify 200
6. 再决定：继续做 §1 进行中任务（域名池 + 真实用户名）/ 批量跑 / 其他

## 8. 产出记录字段（data/accounts.jsonl 每行一个 JSON）

`email` `password` `sess_id` `created_at` `status`（`created`/`verified`/`created-unverified`/`captcha-required`/`failed`/`pending`）`invite_code` `dashboard_url` `verify_link` `gift_claimed` `free_models_enabled` `api_key` `balance` `note`/`error`
