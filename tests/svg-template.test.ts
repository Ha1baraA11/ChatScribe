import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeChatGptComponents,
  renderSvgTemplatesAsMarkdown,
} from "../src/svg-template.ts";

const diagram =
  '<box><svg viewBox="0 0 100 50"><circle cx="25" cy="25" r="10" fill="#00f"/></svg></box>';

describe("SVG diagram export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("omits diagrams from text exports", async () => {
    const result = await renderSvgTemplatesAsMarkdown(
      `Before ${diagram} after`,
      "text",
    );

    expect(result.markdown).toBe("Before  after");
    expect(result.assets).toEqual([]);
  });

  it("leaves diagrams inside fenced code blocks untouched", async () => {
    const source = `\`\`\`xml\n${diagram}\n\`\`\``;
    const result = await renderSvgTemplatesAsMarkdown(source, "text");

    expect(result.markdown).toBe(source);
    expect(result.assets).toEqual([]);
  });

  it("renders safe SVG diagrams as linked PNG assets", async () => {
    const context = {
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(() => "data:image/png;base64,cG5n"),
    };
    const mockImage = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    };

    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });
    vi.stubGlobal("Image", mockImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const result = await renderSvgTemplatesAsMarkdown(diagram, "assets");

    expect(result.markdown).toBe("![Diagram](images/diagram-001.png)");
    expect(result.assets).toEqual([
      expect.objectContaining({
        path: "images/diagram-001.png",
        mimeType: "image/png",
        base64: "cG5n",
      }),
    ]);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:svg");
  });

  it("omits unsafe SVG markup from Markdown exports", async () => {
    const unsafeDiagram =
      '<box><svg viewBox="0 0 10 10"><script>alert(1)</script></svg></box>';
    const result = await renderSvgTemplatesAsMarkdown(unsafeDiagram, "assets");

    expect(result.markdown).toBe("");
    expect(result.assets).toEqual([]);
  });

  it("omits an unsupported diagram while preserving adjacent prose", async () => {
    const unsafeDiagram =
      '<box><svg viewBox="0 0 10 10"><script>alert(1)</script></svg></box>';
    const result = await renderSvgTemplatesAsMarkdown(
      `Before\n\n${unsafeDiagram}\n\nAfter`,
      "assets",
    );

    expect(result.markdown).toBe("Before\n\nAfter");
    expect(result.assets).toEqual([]);
  });

  it("does not alter content when diagram export is disabled", async () => {
    const result = await renderSvgTemplatesAsMarkdown(diagram, "none");

    expect(result.markdown).toBe(diagram);
    expect(result.assets).toEqual([]);
  });
});

describe("ChatGPT visualization normalization", () => {
  it("rebuilds line-by-line sorting passes as a Markdown table", () => {
    const source = [
      "### 冒泡排序：每趟把最大的送到最后",
      "初始",
      "2",
      "12",
      "16",
      "88",
      "5",
      "10",
      "第 1 趟",
      "2",
      "12",
      "16",
      "5",
      "10",
      "88",
      "第 2 趟",
      "2",
      "12",
      "5",
      "10",
      "16",
      "88",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 阶段 | 序列 | 操作说明 |");
    expect(result).toContain("| 初始 | `2, 12, 16, 88, 5, 10` | — |");
    expect(result).toContain("| 第 1 趟 | `2, 12, 16, 5, 10, 88` | — |");
    expect(result).toContain("| 第 2 趟 | `2, 12, 5, 10, 16, 88` | — |");
    expect(result).not.toContain("2\n\n12\n\n16");
  });

  it("keeps insertion notes attached to their sorting pass", () => {
    const source = [
      "### 直接插入排序：前面逐渐形成有序序列",
      "初始",
      "2",
      "12",
      "16",
      "88",
      "5",
      "10",
      "先把 2 看成有序部分",
      "---",
      "第 1 趟",
      "2",
      "12",
      "16",
      "88",
      "5",
      "10",
      "插入 12：12 > 2，无需移动",
      "---",
      "第 2 趟",
      "2",
      "12",
      "16",
      "88",
      "5",
      "10",
      "插入 16：16 > 12，无需移动",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 初始 | `2, 12, 16, 88, 5, 10` | 先把 2 看成有序部分 |");
    expect(result).toContain("| 第 1 趟 | `2, 12, 16, 88, 5, 10` | 插入 12：12 > 2，无需移动 |");
    expect(result).toContain("| 第 2 趟 | `2, 12, 16, 88, 5, 10` | 插入 16：16 > 12，无需移动 |");
  });

  it("keeps sorting legends outside the operation notes", () => {
    const source = [
      "### 直接插入排序",
      "初始",
      "2",
      "5",
      "第 1 趟",
      "2",
      "5",
      "插入 5：5 > 2，无需移动",
      "已排序部分",
      "本趟插入元素",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 第 1 趟 | `2, 5` | 插入 5：5 > 2，无需移动 |");
    expect(result).toContain("| 第 1 趟 | `2, 5` | 插入 5：5 > 2，无需移动 |\n\n图例：已排序部分；本趟插入元素");
    expect(result).not.toContain("<br>已排序部分");
  });

  it("rebuilds the quick-sort partition groups without vertical cells", () => {
    const source = [
      "### 快速排序的完整过程",
      "划分前",
      "5",
      "2",
      "8",
      "1",
      "7",
      "3",
      "按基准 5 划分",
      "2",
      "1",
      "3",
      "小于 5",
      "5",
      "基准",
      "8",
      "7",
      "大于 5",
      "注意：左右分区内部不一定有序。",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("划分前：`[5, 2, 8, 1, 7, 3]`");
    expect(result).toContain("| 小于 5 | `2, 1, 3` |");
    expect(result).toContain("| 基准 | `5` |");
    expect(result).toContain("| 大于 5 | `8, 7` |");
    expect(result).toMatch(/\| 大于 5 \| `8, 7` \|\n{2,}注意：左右分区内部不一定有序。/u);
    expect(result).not.toContain("5\n\n2\n\n8");
  });

  it("rebuilds a flattened five-stage pipeline matrix as a Markdown table", () => {
    const source = [
      "正常情况下，连续指令的执行时间安排如下：",
      "无阻塞的五级流水线",
      "指令",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "I1",
      "IF",
      "ID",
      "EX",
      "MEM",
      "WB",
      "I2",
      "IF",
      "ID",
      "EX",
      "MEM",
      "WB",
      "I3",
      "IF",
      "ID",
      "EX",
      "MEM",
      "WB",
      "横轴表示时钟周期。",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 指令 | 周期 1 | 周期 2 | 周期 3 | 周期 4 | 周期 5 | 周期 6 | 周期 7 |");
    expect(result).toContain("| I1 | IF | ID | EX | MEM | WB | — | — |");
    expect(result).toContain("| I2 | — | IF | ID | EX | MEM | WB | — |");
    expect(result).toContain("| I3 | — | — | IF | ID | EX | MEM | WB |");
    expect(result).toContain("横轴表示时钟周期。");
    expect(result).not.toContain("1\n\n2\n\n3");
  });

  it("rebuilds a stalled pipeline timing diagram with instruction mnemonics", () => {
    const source = [
      "在经典五级流水线、有数据转发的条件下：",
      "流水线执行时序",
      "指令",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "LW",
      "IF",
      "ID",
      "EX",
      "MEM",
      "WB",
      "ADD",
      "IF",
      "ID",
      "暂停",
      "EX",
      "MEM",
      "WB",
      "IF：取指；ID：译码；EX：执行；MEM：访存；WB：写回。表中 ADD 在第 4 周期停留在 ID 阶段，并向执行流水线插入一个气泡。",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 指令 | 周期 1 | 周期 2 | 周期 3 | 周期 4 | 周期 5 | 周期 6 | 周期 7 |");
    expect(result).toContain("| LW | IF | ID | EX | MEM | WB | — | — |");
    expect(result).toContain("| ADD | — | IF | ID | 暂停 | EX | MEM | WB |");
    expect(result).toContain("ADD 在第 4 周期停留在 ID 阶段，并向执行流水线插入一个气泡。");
    expect(result).not.toContain("1\n\n2\n\n3");
    expect(result).not.toContain("LW\n\nIF\n\nID");
  });

  it("keeps a flattened doubly linked list on one connected line", () => {
    const source = [
      "假设有一个双向链表：",
      "5",
      "2",
      "8",
      "1",
      "7",
      "3",
      "每个结点具有前驱指针 prev 和后继指针 next",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("`5 ↔ 2 ↔ 8 ↔ 1 ↔ 7 ↔ 3`");
    expect(result).toContain("每个结点具有前驱指针 prev 和后继指针 next");
    expect(result).not.toContain("5\n\n2\n\n8");
  });

  it("rebuilds IEEE 754 field layouts and encoded bits as horizontal tables", () => {
    const mantissa = "00001000000000000000000";
    const source = [
      "IEEE 754 单精度浮点数共 32 位：",
      "1 位",
      "8 位",
      "23 位",
      "符号",
      "阶码",
      "尾数小数部分",
      "IEEE 754 单精度浮点数共 32 位：",
      "符号",
      "1",
      "阶码",
      "8 位",
      "尾数字段",
      "23 位",
      "1 位符号位 + 8 位阶码 + 23 位尾数字段 = 32 位",
      "最终 IEEE 754 编码",
      "符号",
      "1",
      "阶码",
      "10000010",
      "尾数字段",
      mantissa,
      "按顺序拼接。",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 字段 | 位数 |\n| --- | --- |\n| 符号位 | 1 位 |\n| 阶码 | 8 位 |\n| 尾数字段 | 23 位 |");
    expect(result).toContain("| 字段 | 编码 |\n| --- | --- |\n| 符号位 | 1 |\n| 阶码 | 10000010 |\n| 尾数字段 | 00001000000000000000000 |");
    expect(result).toContain("按顺序拼接。");
    expect(result).not.toContain("符号\n\n1\n\n阶码");
  });

  it("omits unsupported interactive LearningViz markup and its props", () => {
    const component =
      '<LearningViz type_id="INSERTION_SORT" initial_values={{"value1":8,"value2":3}} locale_override="zh-CN"/>';
    const result = normalizeChatGptComponents(`Before\n\n${component}\n\nAfter`);

    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).not.toContain("LearningViz");
    expect(result).not.toContain("initial_values");
  });

  it("converts ChatGPT math delimiters and preserves code spans and fences", () => {
    const source = [
      "Inline \\(x^2\\) and display:",
      "\\[",
      "\\boxed{x}",
      "\\]",
      "",
      "Use `\\(literal\\)` as text.",
      "```latex",
      "\\[",
      "code",
      "\\]",
      "```",
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("Inline $x^2$ and display:\n\n$$\n\\boxed{x}\n$$");
    expect(result).toContain("Use `\\(literal\\)` as text.");
    expect(result).toContain("```latex\n\\[\ncode\n\\]\n```");
  });

  it("preserves LearningViz examples inside fenced code", () => {
    const source = "```xml\n<LearningViz type_id=\"INSERTION_SORT\"/>\n```";

    expect(normalizeChatGptComponents(source)).toBe(source);
  });

  it("renders static quiz questions and choices while removing interactive state", () => {
    const source = [
      '{@body const questions=[{q:"Which register changes on a jump?",opts:["MAR","PC"]}]}',
      '{@body const [answers,setAnswers] = DIL.useState({})}',
      "{#each questions as q,i}",
      "{i+1}. {q.q}",
      '<radio-group value={answers[i]===undefined?"":String(answers[i])}>',
      "{#each q.opts as opt,j}",
      '<radio value={String(j)}>{String.fromCharCode(65+j)}. {opt}</radio>',
      "{/each}",
      "</radio-group>",
      "{#if answers[i]!==undefined}",
      "Hidden answer feedback",
      "{/if}",
      "{/each}",
      "已完成 {Object.keys(responses).length}/1 题，答对 {items.filter((q,i)=>responses[i]===q.a).length} 题",
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("1. Which register changes on a jump?");
    expect(result).toContain("- A. MAR");
    expect(result).toContain("- B. PC");
    expect(result).not.toContain("Hidden answer feedback");
    expect(result).not.toContain("filter(");
    expect(result).not.toContain("{@body");
    expect(result).not.toContain("{#each");
    expect(result).not.toContain("<radio");
  });

  it("preserves true-false answer labels while dropping quiz action buttons", () => {
    const source = [
      '<button onClick={()=>setAnswer(true)}>正确</button>',
      '<button onClick={()=>setAnswer(false)}>错误</button>',
      '<button onClick={()=>reset()}>重新练习</button>',
      '<button onClick={()=>next()}>{step===0?"下一步":"完成"}</button>',
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("- 正确");
    expect(result).toContain("- 错误");
    expect(result).not.toContain("重新练习");
    expect(result).not.toContain("下一步");
    expect(result).not.toMatch(/<\/?button\b/i);
  });

  it("keeps repeated body declarations local to their own question blocks", () => {
    const source = [
      '{@body const questions=[{q:"First question",opts:["A"]}]}',
      "{#each questions as q,i}{q.q}{/each}",
      '{@body const questions=[{q:"Second question",opts:["B"]}]}',
      "{#each questions as q,i}{q.q}{/each}",
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("First question");
    expect(result).toContain("Second question");
    expect(result).not.toContain("First questionSecond question");
  });

  it("turns interactive semaphore steps into a complete static table", () => {
    const source = [
      '{@body const seq=[{s:1,act:"初始",note:"一个资源可用"},{s:0,act:"P",note:"资源耗尽"},{s:-1,act:"P",note:"一个进程阻塞"}]}',
      '{@body const [step,setStep]=DIL.useState(0)}',
      "逐步观察信号量变化",
      "{step+1} / {seq.length}",
      "{seq[step].act}",
      "S = {seq[step].s}",
      "{seq[step].note}",
      "| 可用资源 | 等待进程 |",
      "| --- | --- |",
      "| {Math.max(seq[step].s,0)} | {Math.max(-seq[step].s,0)} |",
      "{#each seq as state,i}{/each}",
      "这里特别注意：负值表示等待进程。",
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 1 | 初始 | 1 | 1 | 0 | 一个资源可用 |");
    expect(result).toContain("| 2 | P | 0 | 0 | 0 | 资源耗尽 |");
    expect(result).toContain("| 3 | P | -1 | 0 | 1 | 一个进程阻塞 |");
    expect(result).toContain("这里特别注意：负值表示等待进程。");
    expect(result).not.toContain("{step+");
    expect(result).not.toContain("{seq[");
  });

  it("rebuilds the memory address visualizations as complete tables", () => {
    const source = [
      "8K×8 位存储器的地址分布",
      "第 1 组",
      "0000H ～ 07FFH",
      "2K×8 位",
      "第 2 组",
      "0800H ～ 0FFFH",
      '<badge color="success">0B1FH 在这里</badge>',
      "{:else}",
      "2K×8 位",
      "第 3 组",
      "1000H ～ 17FFH",
      "2K×8 位",
      "第 4 组",
      "1800H ～ 1FFFH",
      "2K×8 位",
      "后续解释",
      "CPU 访问地址 0B1FH",
      "第 1 组",
      "0000H～07FFH",
      "未选中",
      "第 2 组",
      "0800H～0FFFH",
      '<badge color="success">CS 有效</badge>',
      "第 3 组",
      "1000H～17FFH",
      "未选中",
      "第 4 组",
      "1800H～1FFFH",
      "未选中",
      "后续 CPU 解释",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 芯片组 | 地址范围 | 状态 |");
    expect(result).toContain("| 第 2 组 | 0800H ～ 0FFFH | 0B1FH 在这里 |");
    expect(result).toContain("| 第 1 组 | 0000H～07FFH | 未选中 |");
    expect(result).toContain("| 第 2 组 | 0800H～0FFFH | CS 有效 |");
    expect(result).toContain("后续解释");
    expect(result).toContain("后续 CPU 解释");
    expect(result).not.toContain("{:else}");
  });

  it("rebuilds a linearized two-level page table as rows and columns", () => {
    const source = [
      "二级页表 0",
      "页表项 0",
      "逻辑页 0",
      "页表项 1",
      "逻辑页 1",
      "页表项 2",
      "逻辑页 2",
      "页表项 3",
      "逻辑页 3",
      "二级页表 1",
      "页表项 0",
      "逻辑页 4",
      "页表项 1",
      "逻辑页 5",
      "页表项 2",
      "逻辑页 6",
      "页表项 3",
      "逻辑页 7",
      "后续解释",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 二级页表 | 页表项 | 逻辑页 |");
    expect(result).toContain("| 0 | 3 | 3 |");
    expect(result).toContain("| 1 | 0 | 4 |");
    expect(result).toContain("| 1 | 3 | 7 |");
    expect(result).toContain("后续解释");
    expect(result).not.toContain("页表项 0\n\n逻辑页 0");
  });

  it("rebuilds the PPP frame fields as a horizontal table", () => {
    const source = [
      "PPP 标准帧结构（未启用字段压缩）",
      ...["F", "A", "C", "协议", "信息", "FCS", "F"].flatMap((field, index) => [
        field,
        ["1B", "1B", "1B", "2B", "可变", "2B", "1B"][index],
      ]),
      "后续解释",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| F | A | C | 协议 | 信息 | FCS | F |");
    expect(result).toContain("| 1B | 1B | 1B | 2B | 可变 | 2B | 1B |");
    expect(result).toContain("后续解释");
    expect(result).not.toContain("PPP 标准帧结构（未启用字段压缩）\n\nF\n\n1B");
  });

  it("rebuilds TCP send-window diagrams while retaining their explanation", () => {
    const source = [
      "初始：发送窗口 4000B",
      ...["已发未确认", "已发未确认", "已发未确认", "可以发送"].flatMap((status) => [
        status,
        "1000B",
      ]),
      "此时还能发送 1000B。",
      "收到第一个 1000B 的确认后",
      ...["已发未确认", "已发未确认", "可以发送", "可以发送"].flatMap((status) => [
        status,
        "1000B",
      ]),
      "发送窗口向右移动。",
    ].join("\n\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("| 阶段 | 区块 1（1000B） | 区块 2（1000B） | 区块 3（1000B） | 区块 4（1000B） |");
    expect(result).toContain("| 初始 | 已发未确认 | 已发未确认 | 已发未确认 | 可以发送 |");
    expect(result).toContain("| 收到第一个 1000B 的确认后 | 已发未确认 | 已发未确认 | 可以发送 | 可以发送 |");
    expect(result).toContain("此时还能发送 1000B。");
    expect(result).toContain("发送窗口向右移动。");
    expect(result).not.toContain("已发未确认\n\n1000B");
  });

  it("removes unsupported visuals and controls, preserving their readable neighbors", () => {
    const source = [
      "Before <badge color=\"success\">correct</badge>",
      '<Cite refs={["turn1search1"]}/>',
      '<Chart content={{"chartType":"line","xKey":"rtt","series":[{"dataKey":"cwnd","label":"cwnd（MSS）"}],"data":[{"rtt":"初始","cwnd":1},{"rtt":"1","cwnd":2}],"meta":{"footer":"教材 RTT 模型"}}}/>',
      '<AsyncImage query="a generated diagram"/>',
      "<button onClick={()=>reset()}>Reset</button>",
      "<list><list-item>First point</list-item><list-item>Second point</list-item></list>",
      "After",
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("Before **correct**");
    expect(result).toContain("- First point");
    expect(result).toContain("- Second point");
    expect(result).toContain("| rtt | cwnd（MSS） |");
    expect(result).toContain("| 初始 | 1 |");
    expect(result).toContain("说明：教材 RTT 模型");
    expect(result).toContain("After");
    expect(result).not.toMatch(/<\/?(?:Cite|AsyncImage|button|list|list-item)\b/i);
    expect(result).not.toContain("<Chart");
    expect(result).not.toContain("generated diagram");
    expect(result).not.toContain("Reset");
  });

  it("deindents Markdown math and keeps indented fenced code intact", () => {
    const source = [
      "    **1. Full binary tree**",
      "",
      "    \\[",
      "      x=1",
      "    \\]",
      "",
      "  ```text",
      "    four leading spaces are code content",
      "  ```",
    ].join("\n");

    const result = normalizeChatGptComponents(source);

    expect(result).toContain("**1. Full binary tree**");
    expect(result).toContain("$$\nx=1\n$$");
    expect(result).not.toContain("\\[");
    expect(result).toContain("    four leading spaces are code content");
    expect(result).toContain("  ```text");
  });
});
