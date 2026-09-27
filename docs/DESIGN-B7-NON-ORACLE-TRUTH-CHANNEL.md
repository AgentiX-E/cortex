# B7 非 oracle 真值通道设计

> **状态：设计已定，实测已否证两条最明显的路径，未实现。**
> 本文档按 §14.6 提出的要求，把「真值如何到达系统」这件事
> **做成一个被推理和测量约束过的决定**，而不是留给最短的那条接线。
>
> 全文的关键结论只有一条：
> **`candidateSides` 已经有一个非 oracle 回退，但它结构性地产不出两侧；
> 因此「不给真值」不是一条「效果较差」的路径，而是一条「永远不标注」的路径。**
> 这一条是**实测**的（§16.4），不是推理的。

## 16.1 问题陈述

`discriminateContext` 需要**两侧**才能工作：

```ts
export function discriminateContext(
  turns: readonly TurnLike[],
  options: DiscriminatedContextOptions,   // { question, groundTruth?, answer? }
): DiscriminatedContext {
  const sides = candidateSides(options);
  if (sides.length < 2) {
    return { clusters: [], annotated: false };   // 少于两侧即拒绝标注
  }
  ...
}
```

而调用它的 `NaturalLanguageMemorySystem` **从不接收真值**：
既无 `groundTruth` 字段，`answer(question, context, sessions)` 也无该参数
（§14.5 的 `grep` 证据）。

所以 B7 不是缺一个 spread，而是缺**一条数据通道**。
而通道的设计决定了 A/B 能测出什么。

## 16.2 三条候选通道

| # | 通道 | 两侧来自 | oracle 性质 | 实测状态 |
|---|---|---|---|---|
| **A** | 把 `groundTruth`/`answer` 穿进 `answer()` | 数据集真值 + 基线答案 | **oracle-assisted** | 机制可用，但**测的不是可部署系统** |
| **B** | 只用 `question`，走 `candidateSides` 的既有回退 | 问题自身的限定词 | **非 oracle** | **已实测：只产 1 侧 → 永不标注（§16.4）** |
| **C** | 从**已检索的候选**里抽两侧 | 检索结果（阅读器可见之物） | **非 oracle** | 需新实现；本文档给出设计（§16.6） |

## 16.3 通道 A 为什么不能用

这是 §14.6 已经指出、本文档予以确认的路。它**能跑**——机制健全。
问题是它测出的收益归属于**系统不会拥有的信息**：

推理时正确答案未知，**而这正是问题被问出来的原因**。
把真值用于构建上下文，等于让系统在「已经知道答案」的条件下做判别，
而 A/B 会把这份便利记成 B7 的功劳。

> **一个 oracle-assisted 的 A/B 是可靠的测量，但它测的是另一个系统。**
> 它不会给出错误的数字，它会给出**正确的、关于错误对象的**数字。

所以通道 A 不是「先跑起来再改」，它是一个**必须排除**的选项。

## 16.4 通道 B 已实测：`candidateSides` 的非 oracle 回退产不出两侧

`candidateSides` **已经**为「没有真值」的情况写了分支：

```ts
const truth = contentTerms(options.groundTruth);
const answer = contentTerms(options.answer);
if (truth.length === 0 && answer.length === 0) {
  const fromQuestion = discriminatingQuestionTerms(options.question);
  return fromQuestion.length === 0 ? [] : [fromQuestion];   // ← 恒为一个元素
}
```

注意 `[fromQuestion]`：它**只产出一侧**。
而 `discriminateContext` 在 `sides.length < 2` 时拒绝标注。

实测（真实 `dist`，三轮回合，一个二选一问题）：

```
question: "Which bike did I ride to the coast, the cargo bike or the racing bike?"

NON-ORACLE -> annotated: false | clusters: 0 | indices: []
ORACLE     -> annotated: true  | clusters: 2 | indices: [[0],[1,2]]
```

`candidateSides({question})` 返回的是
`[["bike","ride","coast","cargo","racing"]]`——**五词合成的一侧**，
不是「cargo」对「racing」两侧。

> **这是一个结构性结论，不是参数问题。**
> 问题文本里的两个候选被**合并**进同一侧，因为
> `discriminatingQuestionTerms` 的任务是「找出问题里有辨识力的词」，
> 而不是「把候选拆成对立方」。
>
> 因此：**「不提供真值」并不是一条效果较差的路径，
> 而是一条永远返回 `annotated: false` 的路径。**

这也解释了 §13 的 A/B 空结果为何不能归因于「干预无效」：
即便当时把开关接全，通道 B 的形态也会给出 `annotated: false`，
两臂仍会逐字节相同——**只是这次的原因换成「非 oracle 路径产不出标注」**。

## 16.5 通道 C 的设计：从检索候选里造两侧

这是唯一同时满足**非 oracle** 与**能产两侧**的形态。

### 16.5.1 两侧的定义

```
side₁ = 检索到的回合中被认定支持候选 X 的
side₂ = 检索到的回合中被认定支持候选 Y 的
```

关键在于：X 与 Y 从哪里来。**不能来自真值**（那是通道 A），
**不能要求问题自己已经分好组**（那是通道 B 的失败）。

可行的来源是**检索结果自身的分歧**：

1. 对每个候选答案（`answer` 的复数形态——注意这里用的是**基线系统已产出的候选**，
   不是数据集真值），从已检索回合中收集其内容词；
2. 取其中**出现分歧**的两个候选：即存在回合只支持其一、不支持另一；
3. 这两组内容词构成两侧。

`answer` 沿用的语义需要澄清：`DiscriminatedContextOptions.answer`
指的是**被评估系统给出的答案**，在 A/B 里它由 baseline 臂产出。
若把它作为一侧，则该侧**不含真值**，因此**不违反非 oracle 条件**——
它是系统自己的输出，推理时可得。这一点必须在实现时以注释固定下来，
因为它是本设计里最容易误读的假设。

### 16.5.2 与 `discriminateContext` 现有契约的关系

现有实现**已经**接受 `answer` 并把它当一侧（`answerOnly`）。
所以通道 C 不需要改 `discriminateContext` 的**核心**，
它需要一个**新的上游函数**：

```ts
/**
 * Derives two competing sides from the retrieval result alone.
 * Never consults groundTruth: at inference time it is unknown, and using it
 * would make the measurement oracle-assisted (see docs §16.3).
 */
export function retrievalCandidateSides(input: {
  readonly question: string;
  readonly retrieved: readonly string[];
  readonly answer: string;
}): readonly (readonly string[])[];
```

它返回的形态与 `candidateSides` 相同，供 `discriminateContext` 直接消费。

## 16.6 子包布局与依赖分层

### 16.6.1 位置

| 内容 | 位置 | 理由 |
|---|---|---|
| `retrievalCandidateSides` | `packages/cortex-eval/src/candidate-context.ts` | 与 `candidateSides` 同文件：二者是同一决策的两个分支，分开放会让「哪条是 oracle 路径」需要跨文件读 |
| 类型扩展 | 同上（`DiscriminatedContextOptions` 旁） | 不改动既有类型，新增窄类型 |
| 数据通道穿线 | `packages/cortex-eval/src/natural-language-memory.ts` | §14.5 已确认「从不接收真值」就在这里 |
| 开关转发 | `packages/cortex-eval/src/runner.ts` | §14 已修好的那条链，只需补新选项 |
| 工具（如需要） | `tools/read-b7-nonoracle.mjs` | 与 `read-b7-criterion.mjs` 同形：判据的可执行形态 |

### 16.6.2 依赖分层（不新增任何跨包依赖）

```
cortex-core     (无变化)
     ▲
     │  无新增依赖
cortex-llm      (无变化)
     ▲
cortex-eval     ┌ candidate-context.ts ── 新增 retrievalCandidateSides
                │        ▲ 仅用本文件已有的 contentTerms / foldSuffix
                │
                ├ natural-language-memory.ts ── 新增 retrievalSides 输入
                └ runner.ts ── 转发 candidateDiscrimination（已存在）
```

**为什么不需要新依赖**：通道 C 所需的一切——内容词抽取、
后缀折叠、最辨识词选择——**已经在 `candidate-context.ts` 内**。
新增的只是一个把已有零件组装成「两侧」的函数。

**为什么不动 `cortex-core`**：两侧的推导是**评估侧**的概念
（它关于检索结果的含义），不是记忆层的概念。
放进 `cortex-core` 会让记忆层知道「候选判别」这件事，
而那是 B7 的评估假设，不是记忆层的职责。

### 16.6.3 不新增数据字段

通道 C **不**给 `NaturalLanguageMemorySystem` 添加 `groundTruth` 字段。
它接收的是 `retrieved` 与 `answer`——系统**本来就有**的东西。
这是通道 C 与通道 A 的根本分界：**A 新增信息来源，C 不新增。**

## 16.7 这个设计为什么值得先写下来

三条理由，每条都对应本轮已经发生过的事：

1. **通道 B 的失败形态无法从阅读代码预见。**
   `candidateSides` 里的 `[fromQuestion]` 看起来像「有非 oracle 支持」，
   只有实测才暴露它恒为一侧。若直接实现通道 B，
   会得到一个安静的 `annotated: false`，
   与 §13 的空结果**在产物上不可区分**。

2. **通道 A 的诱惑是「最短的接线」**，而不是「正确的测量」。
   本文档把它写成表格的第一行并且排除了它，正是为了让后来者
   不必重新推一遍这个论证。

3. **子包布局必须现在确定**，因为一旦穿线完成，
   「两侧从哪来」会散落到多个文件，那时再纠正是重构而不是设计。

## 16.8 明确不能主张的

- **不能**说通道 C 会提升 B7 的成绩。它**尚未实现、尚未测量**。
  本文档给出的是可被否证的设计，不是结论。
- **不能**说通道 B「完全无用」。它作为
  「问题里有哪些辨识词」的抽取器是有效的、有测试的；
  它只是**不能同时充当「两侧」的来源**。
- **不能**说非 oracle 一定优于 oracle-assisted。
  正确的说法是：**oracle-assisted 测的是另一个系统**，
  所以它不能回答「B7 对可部署系统是否有效」这个问题。
  对「上界有多大」这个问题，它反而是合适的工具。
- **不能**说本文档已解决 §14.5 的数据通道问题。
  它解决的是**设计**问题：通道 C 存在、可辩护、不引入外部信息。
  **实现、测试、接线、A/B 全都还没做。**

## 16.9 下一步（按优先级）

| # | 事项 | 判据 |
|---|---|---|
| C1 | 实现 `retrievalCandidateSides` | TDD；注入变异 100% 被捕获 |
| C2 | 证明它在真实产物上产 **≥2** 侧 | 与 §16.4 的通道 B 对照实验：同为非 oracle，B 产 1 侧、C 须产 2 |
| C3 | 穿线到 `natural-language-memory.ts` 与 `runner.ts` | 沿用 §14 的 4 个接线测试形态 |
| C4 | 普查门禁须保持绿色 | 新函数必须有非测试调用者（§15 的门禁会强制这一点） |
| C5 | A/B 重跑 | 先验证两臂**不再逐字节相同**——这是 §13 教训的直接应用 |
| C6 | 按判据判决 | 复用 `tools/read-b7-criterion.mjs` |
