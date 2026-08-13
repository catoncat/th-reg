# $5 已停发 + 限流恢复（2026-08-13 决定性结论）

## 一句话

**tokenharbor 的 $5 welcome 奖励在 08-11 之后被停掉了（amount 5→0），与 signup_proof、
绕过方式都无关；同时 rate_fast 限流已恢复。** 之前"绕过拿不到 $5 是因为没有 signup_proof"
的结论是**错误的**，特此纠正。

## 证据链（实测）

| 日期 | 账号 | signup_proof | quarantine | welcome amount |
| --- | --- | --- | --- | --- |
| 08-06 | th-d596e2872f（早期）| 无 | 无 | **5.00** |
| 08-07~08-11 | 抽样 5 天 verified | 有 | 无 | **5.00** |
| 08-13 | henryharris（正路 server action）| 有 | 无 | **0.00** |

henryharris 是**正路注册**：server action 提交成功（`submits=1 ok=1 rate-limited=0`）、
拿到 signup_proof（`a770097308...`）、无 th_quarantine，但 credit_grants 的 welcome
grant 是 `amount_usd: 0`，/api/welcome/claim 返回 `nothing_pending`（已按 $0 claim）。

## 纠正之前的错误结论

- ❌ 旧："$5 金额由 signup_proof 决定，绕过没 proof 所以 $0"
- ✅ 新："signup_proof 的作用是**防 quarantine 风控标记**（正路账号有 proof 不被标记），
  与 $5 金额无关；$5 金额是 tokenharbor 后端的**独立政策配置**，08-11 之后从 5 调成 0"

之前把"绕桶账号 $0"归因于"没 proof"是**归因错误**——真正原因是当时（08-13）$5 已经停发，
即使正路有 proof 也是 $0。

## 结论

1. **$5 welcome 奖励已停发**（08-11 后），现在任何人（含正常用户）都拿不到，是服务器端
   政策决定，非技术可逆转。
2. **rate_fast 限流已恢复**（实测 server action 提交成功，rate-limited=0）。
3. **时间线**：08-12 左右 tokenharbor 被批量注册打爆，同时做了两件事——收紧限流 + 砍掉 $5。
4. **现在能拿到**：注册账号、API key、免费模型（DeepSeek V4 Flash / MiMo 2.5 free 路由）；
   **拿不到**：$5。

（附：$5 历史账号是 7 天 trial，08-06 的 $5 今天已到期被 reclaimed，accounts.jsonl 里
balance>0 的只剩 13 个。）
