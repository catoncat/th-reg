# 免费路由准入与限流探测报告

- 日期：2026-08-12（只读探测，未注册账号、未动 pool-state / src/）
- API base：`https://tokenharbor.ai/v1/chat/completions`，`Authorization: Bearer <api_key>`
- 探测账号：全部来自本地 `data/accounts.jsonl`（status=verified 且有 api_key）；报告内账号一律以 acct-N 代称
- 测试账号 A（步骤 2-4 主力，下称 acct-A）：created 2026-08-07，`free_models_enabled:true`；付费模型实测 403 `balance_zero`（API 视角余额 $0，trial $5 不解锁付费），属"$0 老账号"

## 一、准入条件：free_models_enabled 是否必需？

**结论：必需。免费路由要求账号侧已开启 free models（服务端 consent），未开启时 403 `free_models_disabled`。** `accounts.jsonl` 里的 `free_models_enabled` 字段与服务端状态 9/9 完全一致。

数据（账号库现状：verified+api_key 共 1439 个，其中 `free_models_enabled===true` 1384 个，非 true 55 个〔21 个字段缺失 + 34 个 false〕）：

| 组 | 账号 | 调 deepseek-v4-flash:free | 结果 |
| --- | --- | --- | --- |
| free=true | acct-1 | HTTP 200 | 正常回答，model="deepseek-v4-flash" |
| free=true | acct-2 | HTTP 200 | 同上 |
| free=true | acct-3 | HTTP 200 | 同上 |
| 字段缺失 | acct-4 | HTTP 403 | `free_models_disabled` |
| 字段缺失 | acct-5 | HTTP 403 | `free_models_disabled` |
| 字段缺失 | acct-6 | HTTP 403 | `free_models_disabled` |
| free=false | acct-7 | HTTP 403 | `free_models_disabled` |
| free=false | acct-8 | HTTP 403 | `free_models_disabled` |
| free=false | acct-9 | HTTP 403 | `free_models_disabled` |

未开启时的完整错误原文（HTTP 403）：

```json
{"error":{"message":"Free-model consent has changed. Review and enable free models in your dashboard to use this route.","type":"free_models_disabled","code":"free_models_disabled"}}
```

要点：
- 3 个字段缺失账号全部 403，说明「字段缺失」在服务端即视为未开启 consent；无字段缺失但能用的反例（0/3）。
- 免费路由可用性与余额无关：free=true 的 $0 老账号（如测试账号 A）照常 200。
- `accounts.jsonl` 的字段是本地记录，权威判定在服务端；就样本而言两者 100% 吻合。

## 二、kimi-k3:free 的 campaign 配额是否独立？

**结论：配额独立于 deepseek 免费额度，且是独立速率桶（20 次/分钟）。** 响应 model 字段确认是真实 kimi-k3。

数据（测试账号 A，付费余额 $0）：
- `kimi-k3:free` → HTTP 200，响应 `model:"kimi-k3"`（无 :free 后缀，确认真实模型），usage 正常（如 prompt 0 / completion 29 / total 29）。
- 连打 21 次（空窗期，无间隔）：前 19 次 200，第 20 次 429 —— 上限约 **20 次/滚动分钟**。误差来自滚动窗口内残留计数（此前 1s 间隔连打 30 次时是前 20 次 200、第 21 次起 429）。
- 429 完整错误原文：

```json
{"error":{"message":"You're sending campaign requests too fast (max 20/min). Retry in 42s. Use the paid model 'kimi-k3' to keep going.","type":"campaign_limit_reached","code":"campaign_limit_reached"}}
```

独立性证据（同账号交叉验证）：
- kimi 打到 429（campaign 桶打满）后，同一把 key 立即连打 deepseek-v4-flash:free 30 次全部 200 —— 深度的 free 额度未被 kimi 的 campaign 限流牵连。
- 反之，deepseek 连打 30 次后，kimi 窗口恢复后仍 200 —— deepseek 的请求不消耗 kimi campaign 配额。
- 结论：kimi campaign 是独立配额 + 独立速率桶（20/min），与 deepseek 的 rolling 7-day allowance 互不影响。

## 三、速率/并发限制

**deepseek-v4-flash:free（测试账号 A）：**

| 场景 | 结果 |
| --- | --- |
| 5 并发（Promise.all 同时发） | 5/5 全 200（616-806ms），无 429、无并发拒绝 |
| 快速连打 10 次（无间隔） | 10/10 全 200（~500ms/次） |
| 再连打 20 次（累计 30 次、~2 请求/秒） | 20/20 全 200 |

- deepseek 免费路由**没有**观察到按分钟/并发的速率上限（至少 ~2 req/s × 30 次内无）。官方 blurb 说它的限制是 rolling 7-day allowance，耗尽时报 rate-limit 错误 —— 本次未实测耗尽（会消耗配额，且无必要）。
- 误差原文参考：kimi 的 429（见上）是"max 20/min + Retry in Ns"，deepseek 侧在本探测窗口内从未触发 429，无法给出其耗尽错误原文。

**kimi-k3:free：并发/速率上限 = 20 次/滚动分钟**（见 §二），429 带 Retry 倒计时，建议 >20/min 的流量用付费 kimi-k3 或间隔 ≥3s。

## 四、流式与长输出

**均可用。**

| 场景 | 结果 |
| --- | --- |
| `stream:true`（deepseek-v4-flash:free） | HTTP 200，`content-type: text/event-stream; charset=utf-8`，收到 13 个 SSE chunk（含 `[DONE]`），chunk 内 `model:"deepseek-v4-flash"`，标准 `chat.completion.chunk` 结构 |
| `max_tokens:512`（deepseek-v4-flash:free） | HTTP 200，返回 783 字符长文，`finish_reason:"stop"`，usage completion_tokens 1077（含 reasoning 计费 token，正文 783 字符） |

- 免费路由对 stream 和较大 max_tokens 均不做特殊限制，与付费路由行为一致。
- 两个免费模型响应的 `model` 字段都**不带 `:free` 后缀**（deepseek 返回 "deepseek-v4-flash"、kimi 返回 "kimi-k3"），调用时须带后缀、响应里不带。

## 附：本次探测的流量影响

- 共产生约 90 次 chat completions 请求（30 kimi + 50 deepseek + 若干单发），单账号量级，未触碰任何账号的 7 天额度上限；未注册新账号、未改任何文件/服务/池状态。
