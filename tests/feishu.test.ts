import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  channelSchema,
  defaultConfig,
  migrateSettings,
  noticeLabels,
} from "../shared/config";
import { renderFeishuCard } from "../shared/feishu";
import { notificationExample } from "../shared/notification-example";
import {
  defaultCardTemplate,
  extractionExamples,
} from "../shared/template-schema";
import type { MessageFormat } from "../shared/templates";
import { buildRequest, deliver, type Fetch } from "../server/channels";
import { exportConfiguration, planImport } from "../server/transfer";
import { parseTransfer } from "../shared/transfer";

const channel = channelSchema.parse({
  id: "team",
  name: "开发群",
  kind: "feishu",
  feishu: { messageType: "card" },
});
const credentials = {
  url: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  signingSecret: "test-secret",
  bearerToken: "",
  headers: {},
};

type Card = ReturnType<typeof renderFeishuCard>;

function cardWith(
  notice: Parameters<typeof renderFeishuCard>[0],
  format: MessageFormat = {
    ...defaultConfig().notifications,
    includePreview: true,
  },
) {
  return renderFeishuCard(notice, format);
}

function withCard(
  card: Partial<ReturnType<typeof defaultCardTemplate>>,
  includePreview = true,
): MessageFormat {
  return {
    ...defaultConfig().notifications,
    includePreview,
    card: { ...defaultCardTemplate(), ...card },
  };
}

function bodyText(card: Card): string {
  const element = card.elements[0];
  if (element?.tag !== "div") throw new Error("card body is not a div");
  return element.text.content;
}

function columnSet(card: Card) {
  const element = card.elements.find((item) => item.tag === "column_set");
  if (!element || element.tag !== "column_set")
    throw new Error("card has no metadata columns");
  return element;
}

describe("Feishu message types", () => {
  it("keeps legacy channels in text mode through settings migration", () => {
    const old = defaultConfig();
    old.channels = [
      channelSchema.parse({ id: "team", name: "开发群", kind: "feishu" }),
    ];
    old.routing.host = ["team"];
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
      const next = migrateSettings(old, version);
      expect(next.routing.host).toEqual(["team"]);
      expect(next.notifications.card).toEqual(defaultCardTemplate());
      expect(
        JSON.parse(
          buildRequest(next.channels[0]!, credentials, notificationExample(), 0)
            .body,
        ).msg_type,
      ).toBe("text");
      expect(next.notifications.includePreview).toBe(false);
    }
    expect(
      channelSchema.safeParse({
        ...channel,
        feishu: { messageType: "invalid" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["completed", "green"],
    ["recovered", "green"],
    ["failed", "red"],
    ["blocked", "red"],
    ["permission", "yellow"],
    ["test", "blue"],
  ] as const)("renders %s as a %s header", (kind, color) => {
    const notice = notificationExample(kind);
    const payload = JSON.parse(
      buildRequest(channel, credentials, notice, 1700000000000).body,
    );
    expect(payload.msg_type).toBe("interactive");
    expect(payload.content).toBeUndefined();
    expect(payload.card.header).toEqual({
      template: color,
      title: { tag: "plain_text", content: "Paseo · 每日构建检查" },
    });
    expect(payload.card.elements[0].text.content).toContain(
      `**${noticeLabels[kind]}**`,
    );
    expect(payload.timestamp).toBe("1700000000");
    expect(payload.sign).toBe(
      createHmac("sha256", "1700000000\ntest-secret")
        .update("")
        .digest("base64"),
    );
  });

  it("renders the default card template into body and metadata columns", () => {
    const card = cardWith(notificationExample());
    expect(card.header.title.content).toBe("Paseo · 每日构建检查");
    expect(bodyText(card)).toBe(
      [
        "**任务完成**",
        "请在 Paseo 查看任务结果。",
        "已处理工单 PROJ-123。",
        "结果：https://example.com/result/123",
        "全部检查通过。",
        "会话：检查构建失败原因",
      ].join("\n"),
    );
    expect(card.elements[1]).toEqual({ tag: "hr" });
    const columns = columnSet(card).columns;
    expect(columns.map((column) => column.weight)).toEqual([3, 1]);
    expect(columns[0]).toMatchObject({
      width: "weighted",
      background_style: "green-50",
      padding: "8px 10px 8px 10px",
      vertical_align: "top",
    });
    expect(columns[0]!.elements[0]!.text).toEqual({
      tag: "lark_md",
      content: "<font color='green'>**codex**</font>",
    });
    expect(columns[1]!.elements[0]!.text.content).toMatch(
      /^<font color='green'>\*\*\d{2}:\d{2}\*\*<\/font>$/,
    );
    expect(columnSet(card)).toMatchObject({
      flex_mode: "none",
      horizontal_spacing: "12px",
      background_style: "default",
    });
  });

  it("falls back to the status summary without a preview", () => {
    const card = cardWith(notificationExample(), {
      ...defaultConfig().notifications,
      includePreview: false,
    });
    expect(bodyText(card)).toContain("请在 Paseo 查看任务结果。");
    expect(JSON.stringify(card)).not.toContain("PROJ-123");
  });

  it("renders a configured card template with custom placeholders", () => {
    const format = withCard({
      title: "通知 · {{event}}",
      body: "工单：{{custom.ticket}}\n{{summary}}",
      meta: ["{{provider}}", "{{failure}}"],
    });
    format.template.rules = [extractionExamples[0]!.rule];
    const card = cardWith(notificationExample(), format);
    expect(card.header.title.content).toBe("通知 · 任务完成");
    expect(bodyText(card)).toBe("工单：PROJ-123\n请在 Paseo 查看任务结果。");
    // An empty metadata cell is hidden instead of rendering a blank block.
    expect(card.elements).toHaveLength(3);
    expect(columnSet(card).columns).toHaveLength(1);
    expect(columnSet(card).columns[0]!.elements[0]!.text.content).toBe(
      "<font color='green'>**codex**</font>",
    );
  });

  it("renders local time and date placeholders", () => {
    const card = cardWith(
      notificationExample(),
      withCard({ body: "{{date}} {{time}}", meta: [] }),
    );
    expect(bodyText(card)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(card.elements).toHaveLength(1);
  });

  it("shows recovery attempts and the failure reason", () => {
    const card = cardWith(
      notificationExample("failed"),
      withCard({
        body: "**{{event}}**\n{{recovery}}\n**失败原因**：{{failure}}",
      }),
    );
    expect(bodyText(card)).toBe(
      "**任务失败**\n自动恢复尝试：2 次\n**失败原因**：网络故障",
    );
  });

  it("applies the preview privacy switch before rendering the card", () => {
    const format = defaultConfig().notifications;
    const notice = notificationExample();
    expect(JSON.stringify(cardWith(notice, format))).not.toContain("PROJ-123");
    format.includePreview = true;
    notice.preview = "x".repeat(80) + "SECRET-123";
    format.previewCharacters = 80;
    const shown = cardWith(notice, format);
    expect(JSON.stringify(shown)).toContain("x".repeat(80));
    expect(JSON.stringify(shown)).not.toContain("SECRET");
  });

  it("downgrades headings, quotes and tables outside fenced code", () => {
    const card = cardWith(
      {
        ...notificationExample(),
        preview: [
          "# 标题",
          "> 引用",
          "| 项目 | 结果 |",
          "| --- | --- |",
          "| 构建 | 通过 |",
          "```",
          "# 代码内保留",
          "```",
        ].join("\n"),
      },
      withCard({ body: "{{preview}}", meta: [] }),
    );
    expect(bodyText(card)).toBe(
      ["**标题**", "▎引用", "- 构建：通过", "```", "# 代码内保留", "```"].join(
        "\n",
      ),
    );
  });

  it("keeps wide tables readable as a bold header and bullet rows", () => {
    const card = cardWith(
      {
        ...notificationExample(),
        preview: [
          "| 项目 | 状态 | 耗时 |",
          "| --- | --- | --- |",
          "| 构建 | 通过 | 3s |",
        ].join("\n"),
      },
      withCard({ body: "{{preview}}", meta: [] }),
    );
    expect(bodyText(card)).toBe(
      ["**项目｜状态｜耗时**", "- 构建｜通过｜3s"].join("\n"),
    );
  });

  it("neutralizes mentions but leaves entities literal", () => {
    const card = cardWith(
      { ...notificationExample(), preview: 'A & B <at user_id="all">全体</at>' },
      withCard({ body: "{{preview}}", meta: [] }),
    );
    expect(bodyText(card)).toBe('A & B 〈at user_id="all">全体</at>');
  });

  it("truncates the body within the byte budget after downgrading", () => {
    const format = withCard({ body: "{{preview}}", meta: [] });
    format.previewCharacters = 20000;
    const card = cardWith(
      { ...notificationExample(), preview: "# 标题\n" + "x".repeat(20000) },
      format,
    );
    const content = bodyText(card);
    expect(Buffer.byteLength(JSON.stringify(content)) - 2).toBeLessThanOrEqual(
      8000,
    );
    expect(content.endsWith("…")).toBe(true);
  });

  it.each(["text", "card"] as const)(
    "bounds the complete signed %s request after JSON escaping",
    (messageType) => {
      const format = defaultConfig().notifications;
      format.template.title = "{{summary}}";
      format.template.body = "{{summary}}{{summary}}";
      for (const content of ["\u0000", '"\\\n', "中文🌍", "\ud800"]) {
        const request = buildRequest(
          { ...channel, feishu: { messageType } },
          credentials,
          {
            ...notificationExample(),
            summary: content.repeat(10000),
            preview: content.repeat(10000),
          },
          1700000000000,
          format,
        );
        expect(Buffer.byteLength(request.body)).toBeLessThanOrEqual(20000);
        const payload = JSON.parse(request.body);
        const text =
          messageType === "card"
            ? payload.card.elements[0].text.content
            : payload.content.text;
        expect(text).toBeTruthy();
        expect(text).toMatch(/…$/);
        if (content === "中文🌍") expect(text).not.toMatch(/[\uD800-\uDBFF]…$/);
      }
    },
  );

  it("sends a card through the existing transport and checks the platform receipt", async () => {
    let body = "";
    const fetcher: Fetch = async (_url, request) => {
      body = request.body;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    };
    await deliver(
      channel,
      { ...credentials, signingSecret: "" },
      notificationExample(),
      new AbortController().signal,
      { fetcher, format: defaultConfig().notifications },
    );
    expect(JSON.parse(body)).toMatchObject({ msg_type: "interactive" });
    expect(JSON.parse(body)).not.toHaveProperty("sign");
  });

  it("round-trips card settings and prevents older plugins silently importing them as text", () => {
    const config = defaultConfig();
    config.channels = [channel];
    config.routing.host = [channel.id];
    const secrets = { team: { kind: "feishu" as const, values: credentials } };
    const bundle = parseTransfer(exportConfiguration(config, secrets, true));
    expect(bundle.version).toBe(2);
    const first = planImport(defaultConfig(), {}, bundle, () => "import-team");
    expect(first.config.channels[0]!.feishu?.messageType).toBe("card");
    expect(first.staged["import-team"]!.values).toMatchObject(credentials);
    expect(planImport(first.config, first.staged, bundle).reused).toBe(1);
    first.config.channels[0]!.feishu = { messageType: "text" };
    expect(
      planImport(first.config, first.staged, bundle, () => "import-card").added,
    ).toBe(1);
    config.channels[0] = { ...channel, feishu: undefined };
    const legacy = parseTransfer(exportConfiguration(config, {}, false));
    expect(legacy.version).toBe(1);
    const imported = planImport(
      defaultConfig(),
      {},
      legacy,
      () => "import-text",
    );
    imported.config.channels[0]!.feishu = { messageType: "text" };
    expect(planImport(imported.config, {}, legacy).reused).toBe(1);
  });
});
