# 免费配额探测报告（free-tier quota probe）

> 探测日期：2026-08-12 ｜ 方式：纯 HTTP 只读探测（未注册新账号、未改任何文件、未动 pool-state、未重启服务）
> API base：https://tokenharbor.ai/v1/chat/completions，Bearer 鉴权，直连
> 账号：2026-08-06 注册、余额 $0 的两个 verified 老账号（下称 acct1 / acct2）

## 结论摘要

1. **配额边界：120 次请求 / 16,278 token 未触限**（deepseek-v4-flash:free，间隔 1s，messages=[{user:"hi"}]，max_tokens=1）。按任务规则（第 6 步）打满 120 次仍未限流即停止、不再加压，因此**未能测到真实上限**——配额远大于 120 次小请求，需更大规模（或更长 token）才能触到边界。
2. **限流错误原文：未观测到**（无任何非 200 响应）。无完整 body 可提供；附上同账号付费模型的 403 body 作为「该账号余额 $0」的对照（见下）。
3. **三个免费模型共享 vs 独立：无法从本次探测实证**。三个模型在同一 $0 账号均返回 200（可用），未触限故无法从限流行为判断共享关系。官方 blurb 明示：deepseek-v4-flash:free 与 mimo-v2.5:free **共享**「rolling 7-day allowance」，kimi-k3:free 走**独立** campaign allowance。
4. **是否 per-account：未实测到（未触限），但可用性确认是 per-account 的**。两个不同的 $0 账号调 flash:free 均 200；配额本身按官方说明为账号级（rolling 7-day，绑定 key/账号），本次未触限无法实证边界。
5. **恢复行为：不适用**（未触发限流，无从观察 300s 恢复；限流窗口是滚动还是固定未经验证）。

## 基线对照（证明这是 $0 废账号，:free 与付费模型行为分叉）

| 账号 | 模型 | HTTP | 响应 |
| --- | --- | --- | --- |
| acct1 | deepseek-v4-flash（付费） | 403 | {"error":{"message":"Your Token Harbor balance is at $0. Top up at https://tokenharbor.ai/dashboard to keep using paid models.","type":"balance_zero","code":"balance_zero"}} |
| acct2 | deepseek-v4-flash（付费） | 403 | 同上 |
| acct1 | deepseek-v4-flash:free | 200 | 正常生成 |
| acct1 | mimo-v2.5:free | 200 | 正常返回（content 空、finish_reason=length，max_tokens=1 生效） |
| acct1 | kimi-k3:free | 200 | 正常生成（prompt_tokens=0，走 campaign 不计 prompt） |
| acct2 | deepseek-v4-flash:free | 200 | 正常生成 |

## 探测过程（步骤 2：120 连打）

- 模型 deepseek-v4-flash:free，间隔 1s，共 **120 次全部 200**，无一次非 200。
- 累计 usage：**total_tokens = 16,278**（prompt 84 + completion 50 每次，均值 ~135.65/次）。
- 注意：flash:free **不尊重 max_tokens=1**——每次返回完整问候语「Hi! How can I help you today?」，usage 按真实生成计（completion 50 token）。即「1 token 请求」实际每次烧 ~134 token；若配额是 token 型，120 次 ≈ 16.3k token 已消耗且未触限。
- mimo-v2.5:free 尊重 max_tokens（completion=1）；kimi-k3:free 返回 29 token 且 prompt_tokens=0（campaign 不计 prompt）。

## 原始数据（关键转折点；全 120 次无转折，故只列首/中/尾）

| 请求序号 | 状态码 | total_tokens | 备注 |
| --- | --- | --- | --- |
| 1 | 200 | 134 | 起始 |
| 2–119 | 200 | 134/次 | 全程无变化 |
| 120 | 200 | 134 | 打满停止（未触限，按规则不再加压） |

## 未验证项与后续建议

- 真实配额边界未触达：需 >120 次或更长输出（如多轮长 prompt）才可能触限；任务明确要求不加大规模，故停手。
- 三模型共享性、per-account 边界、滚动/固定窗口恢复：均需先触限才能实证；当前仅官方 blurb 可引用（flash+mimo 共享 rolling 7-day；kimi 独立 campaign）。
- 若要后续补测：建议单独用一个 2026-08-06 的 $0 账号、把 max_tokens 提到 512 连续打，先确认配额是 request 型还是 token 型。
