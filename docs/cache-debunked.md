# 缓存与 thinking 调查:已推翻的结论(2026-08-12)

本文件专门记录**被实测推翻的旧结论**。看到旧记忆/旧文档里出现这些说法时,以本文件为准。

## 1. 「TokenHarbor 上游开 thinking 就不返回思考内容」—— 错

**旧说法**:claude-opus-5 / sonnet-5 / fable-5 开 thinking 时上游不返回 thinking block,`thinking_tokens` 为 0,属"纯亏"。

**推翻依据(2026-08-12)**:旧测试用的题目是「27×43 等于多少」这类简单题。`thinking:{type:"adaptive"}` 的语义是**模型自主决定是否思考**,简单题不思考是正确行为,不是上游丢弃。

换成真正需要推理的题(5 人排队约束推理 / 3x3 方格约束填数),同一条 gateway 路径立刻返回 thinking block:

```
model=claude-opus-5, thinking={type:"adaptive",display:"summarized"}, output_config={effort:"high"}
→ status 200, content_block 类型 = ["thinking"]
```

**教训**:测 adaptive thinking 必须用真正需要推理的任务,否则得到假阴性。

## 2. 「GPT 系模型在本机各路径拿不到 reasoning」—— 同样不可靠

用同一道硬题实测三条路径(2026-08-12),全部正常返回 reasoning:

| provider | 模型 | reasoning item | reasoning_tokens | summary |
| --- | --- | --- | --- | --- |
| ai-rs | gpt-5.6-sol | 3 个 | 1434 | 有 |
| ha-openai | openai/gpt-5.6-sol | 2 个 | 1002 | 有(1427 字) |
| cpa | gpt-5.4 | 1 个 | 7492 | 有(1445 字) |

注意:这三条**都不是** TokenHarbor 路径。旧结论针对的是 `tokenharbor-openai`,而该 provider 已按旧(不可靠的)结论从 `~/.pi/agent/models.json` 删除。**要判定 TH 走 GPT 到底行不行,需要把该 provider 临时加回、用硬题重测**,目前没有可信数据。

**TH 路径可信数据(2026-08-13,硬题 5 人排队约束)**:TH 上游对 gpt-5.6-sol/luna/terra 三协议全无思考输出——
OpenAI chat(含 reasoning_effort=high)无 reasoning_content、usage 无 reasoning_tokens;OpenAI responses 的
output 只有 message 类型、无 reasoning item;/v1/messages(Anthropic)带 thinking(enabled/adaptive)只回 text block。
对照组:同题同参数,TH 的 deepseek-v4-flash OpenAI 路径返回 reasoning_content;同一 openai/gpt-5.6-sol 在
ai-rs(apiproxy.fly.dev)responses 路径返回 output=[reasoning,message](encrypted_content)。**结论:TH 后端对
GPT 系剥离/不产生 reasoning 通道,思考过程只会出现在 content 正文里;要 GPT 的独立思考值请走 ai-rs 等有
reasoning 的 provider,TH 上做不到(非配置问题,models.json 已把 gpt-5.6-* reasoning 标 false)。**

## 3. 「开启 thinking 会导致增量 prompt cache 不写入」—— 错

**旧说法**:严格对照显示 thinking 开 → `cache_creation=0`、新增尾部每轮全价重付;thinking 关 → 正常写缓存。据此曾判定这是真实会话 48 轮 write=0 的根因。

**错因**:旧测试用的是**过时的 API 格式** `thinking:{type:"enabled", budget_tokens:N}`。pi 真实发送的是 `thinking:{type:"adaptive", display:"summarized"}` + `output_config:{effort}`。用错格式时上游行为不可参考。

**用 pi 真实格式重测(2026-08-12,3 轮,含 tool_use + tool_result,唯一变量是 thinking 开关)**:

| 组 | turn1 | turn2 | turn3 |
| --- | --- | --- | --- |
| THINK(adaptive 开) | read=9497 write=0 in=112 | **write=203** read=9497 in=2 | **write=1185** read=9700 in=2 |
| NOTHINK(关) | read=9497 write=0 in=113 | **write=204** read=9497 in=2 | **write=1149** read=9701 in=2 |

两组差异在噪声范围内(203 vs 204、1185 vs 1149)。**thinking 开关对 prompt cache 写入没有影响,两种情况都健康增量。**

## 4. 由此产生的连带动作与当前状态

| 动作 | 状态 |
| --- | --- |
| 把 `claude-fable-5`/`claude-opus-5` 的 `thinkingLevelMap.off` 从 `null` 改成 `"none"` | **已回滚**,models.json 恢复原状(与 `models.json.bak-cachefix-*` 一致,JSON 合法) |
| 建议把三个 claude 模型 `reasoning` 改 false | **未执行**,依据已被推翻,不要再做 |
| 删除 `tokenharbor-openai` provider | **已发生且未恢复**,依据不可靠;要恢复需先用硬题重测 |

## 5. 关于 `[redacted]` 显示

会话正文里品牌名显示成 `[redacted]` 不是存储或显示层过滤。证据:同一条消息里 `toolCall.arguments.code`(工具调用参数)中品牌词是原文,只有自然语言 prose 被替换。这是**生成 prose 时底层模型自身的内容策略**(本会话路由为 `tokenharbor-chat / th-orchestra`),不影响任何数据或代码。

## 6. 缓存问题的真实状态

原始现象(真实会话 48 轮 `cacheWrite=0`、`cacheRead` 冻在 22888、uncached input 从 1225 爬到 56572)**至今没有可信根因**。已排除:

- pi 没打断点 —— 排除(cache-probe.log 显示每轮都打了 system[0]/tools/msg[last].tool_result[0])
- gateway 改写 cache_control —— 排除(纯透传)
- 换 key 导致 —— 排除(5 个 key 轮换后 cacheRead 仍冻结在同一数值,说明 TH 后端多账号共用一个上游缓存池)
- thinking 开启 —— **本次排除**(见第 3 节)

仍未排除:并发请求(主线程 + sub-agents 打同一上游缓存池)造成的写入竞争;ephemeral 5min TTL 与长任务的交互。**下次接手请从并发竞争这条线入手,不要重复上面已排除的四条。**
