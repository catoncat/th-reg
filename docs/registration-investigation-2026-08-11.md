# 注册失败率排查 — 定案

- 首次排查：2026-08-11（只列事实与假设，未定案）
- 定案：2026-08-11 晚，实测推翻了首次排查的核心判定

## 1. 真因

signup POST 返回 `200` 时，body **不是** Vercel Security Checkpoint 挑战页，而是 React-19
server action 重新渲染的注册页；action 的返回值就在 hidden input `$ACTION_1:1` 里，明确写着
服务端为什么拒绝。旧代码只把 `body.slice(0, 160)` 记进 `accounts.jsonl`，那 160 字节全是
`<!DOCTYPE html><html data-dpl-id=...`，于是 **1070 次业务拒绝被记成匿名 "checkpoint-200"**，
整条排查线索被这层截断掩埋。

实测到的四种服务端文案：

| 分类 | 文案 | 维度 | 换 IP 有用？ |
| --- | --- | --- | --- |
| `rate_fast` | You're doing that a bit fast — take a breath and try again. | **跨出口 IP 共享的提交速率桶** | ❌ 只能等 |
| `rate_network_hour` | Too many sign-ups from this network. Please try again in an hour. | 出口网络，1 小时 | ✅ |
| `unsupported` | Your IP or email provider is not supported for Token Harbor accounts. | IP / 邮箱域名信誉 | ✅ |
| `validation` | 例：Password needs at least 12 characters. | 我们自己的 payload（**校验先于限流**） | — |

主导失败是 `rate_fast`：三条跑在互不相关住宅 IP 上的探针 arm **同步进入、又同步离开**被拒状态，
说明桶是跨 IP 共享的；而 3 个 worker 各自独立提交、失败后立刻换 IP 重试，等于对着这个桶加倍猛打。

## 2. 已排除的维度（都做了对照实测）

| 维度 | 实测 |
| --- | --- |
| 出口 IP 新鲜度 | 30 个 sticky session → 30 个唯一 IP、30 个唯一 /24；照样被拒 |
| 邮箱域名 | 近三日各域成功率 24%–59%（n≈35–50），属二项噪声，无分层 → **不需要换邮箱域名** |
| invite_code | 去掉邀请码，`rate_fast` 率不变 |
| 请求指纹 | 补齐 `sec-fetch-*`/`origin`/`referer`/`accept-language`/`sec-ch-ua` 后无显著差异 |
| GET→POST 停顿 | 停 15 秒模拟填表，5/5 仍被拒 |
| 单纯 pacing | 60 秒固定间隔在桶已欠深时无效（这也是首次排查误判「pacing 无效」的原因） |

## 3. 与历史数据的一致性

- 整体 1129 成功 / 1278 失败 ≈ 46.9%；近期跌到 18–36%，失败中 86–91% 是 `rate_fast`。
- 按 10 分钟桶分组（控制时间，只看 08-09 之后）：桶内 1–5 次尝试 → 64.2%；31+ 次 → 28.9%。
- 停机 20 分钟以上再启动，首批成功率 67.1%，高于同期整体 51.6%。
- 三者一致指向「提交速率」而非「身份/网络被拉黑」。

## 4. 修复

- `src/http.mjs` `parseSignupReject(body)`：解析 action 返回值并归类，`accounts.jsonl` 从此记
  `reject_class` + 真实文案，不再是 `<!DOCTYPE html>`。顺带记 `egress_ip`。
- `src/pacer.mjs` `createSignupPacer`：**只**把 signup 提交这一步跨 worker 串行化，间隔 AIMD
  自适应（成功 ×0.7，撞到共享桶 ×2，区间 4s–240s）。提交之后的邮件 RTT / claim / key 仍并行，
  所以吞吐没被牺牲。
- `src/register.mjs`：`rate_fast` 不再原地换 IP 重试（换了也没用，纯烧时间），只有
  `rate_network_hour` / `unsupported` / transport / pagefail 才轮换 sticky session；
  `send-verification-email` / `claim` / `api/keys` 加 transport 重试，隧道抽风不再废掉已建成的账号。
- `src/supply.mjs`：速率拒绝不再计入 `failStreak`（否则限流会让整轮停机），单独计数并由 pacer 退避；
  收尾日志打印 submits/ok/rate/gap。
- `scripts/signup-probe.mjs`：单发诊断，直接打印 reject 分类。

## 5. 验收（2026-08-11 实测，sticky 代理，workers=3）

| 批次 | 结果 | pacer |
| --- | --- | --- |
| count 4 / workers 2 | 4/4 verified，76s | submits 5，rate-limited 0，gap→4s |
| count 12 / workers 3 | 11/12 verified（1 次隧道抽风），149s | submits 18，rate-limited 0 |
| count 9 / workers 3 | 9/9 verified，101s | submits 9，rate-limited 0 |

合计 **24/25 = 96%**（改造前近期 20–30%），全部 $5 到账 + 明文 key。

## 6. 遗留

- 剩余失败源是 DataImpulse 隧道 transport 错误（约 10–20% 的单次请求），已加重试，仍会偶发废账号。
- `unsupported` 偶发（本次 1 次），换 sticky IP 即过；如果某天变成常态，才需要考虑换代理源或邮箱域名。
- pacer 的 4s 下限是保守值。若想再压吞吐，可下调 `TH_SIGNUP_MIN_GAP_MS` 观察 `rate_fast` 是否回升。
- 首次排查的假设 H_network / H_fingerprint 已被 §2 的对照实测排除，不必再追。
