import { noticeLabels, type NoticeKind } from "./config";
import type { Notification } from "./contracts";
import { defaultCardTemplate } from "./template-schema";
import { renderTemplateText, type MessageFormat } from "./templates";

// The original codex-dashboard card had no orange token, so blocked and
// permission reuse its red (failed) and yellow (waiting) colors.
export const feishuColors: Record<
  NoticeKind,
  "green" | "red" | "yellow" | "blue"
> = {
  completed: "green",
  recovered: "green",
  failed: "red",
  blocked: "red",
  permission: "yellow",
  test: "blue",
};

// Bound UTF-8 bytes *after JSON escaping*, without Node/DOM APIs (also used
// by Android Hermes previews). Reserve three bytes for the ellipsis.
export function truncateJsonText(text: string, maxBytes: number): string {
  let result = "",
    bytes = 0,
    prefix = "";
  for (const char of text) {
    const escaped = JSON.stringify(char).slice(1, -1);
    let size = 0;
    for (const c of escaped) {
      const point = c.codePointAt(0)!;
      size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    if (bytes + size > maxBytes) return `${prefix}…`;
    bytes += size;
    result += char;
    if (bytes <= maxBytes - 3) prefix = result;
  }
  return result;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
}

/**
 * Feishu's card text renders a Markdown subset: headings, tables and
 * blockquotes reach the client as literal characters. Rewrite them into bold,
 * bullet and prefixed lines so AI output and templates stay readable. Fenced
 * code is passed through untouched because it is the one place those markers
 * are expected verbatim.
 */
function downgradeMarkdown(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let fenced = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      output.push(line);
      continue;
    }
    if (fenced) {
      output.push(line);
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      output.push(`**${heading[1]}**`);
      continue;
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      output.push(`▎${quote[1]}`);
      continue;
    }
    if (
      isTableRow(line) &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1]!)
    ) {
      const header = tableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index]!)) {
        rows.push(tableCells(lines[index]!));
        index++;
      }
      index--;
      if (header.length === 2) {
        for (const row of rows)
          output.push(`- ${row[0] ?? ""}：${row[1] ?? ""}`);
      } else {
        if (header.length) output.push(`**${header.join("｜")}**`);
        for (const row of rows) output.push(`- ${row.join("｜")}`);
      }
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

// The card body is a Feishu rich-text block: the subset above is downgraded
// first, and Feishu does not decode HTML entities, so only mentions are
// neutralized instead of escaping the whole body.
function cardMarkdown(text: string, maxBytes: number): string {
  return truncateJsonText(
    downgradeMarkdown(text).replace(/<at\b/gi, "〈at"),
    maxBytes,
  );
}

// Metadata cells are short single-line values; collapse whitespace so a long
// workspace name cannot break the column layout.
function cardCell(value: string, maxBytes: number): string {
  return truncateJsonText(
    value
      .replace(/\s+/g, " ")
      .trim()
      .replace(/<at\b/gi, "〈at"),
    maxBytes,
  );
}

// Matches the original codex-dashboard card: a compact delivery time rather
// than a locale-formatted date, since Feishu already prints the message date.
function formatCardTime(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cardDiv(content: string) {
  return { tag: "div" as const, text: { tag: "lark_md" as const, content } };
}

// The metadata strip follows the original codex-dashboard card: one color
// tinted, padded column per fact, with the semantic event color carried into
// the text and the weights fixed at 3:1.
function cardColumn(value: string, color: string, weight: number) {
  return {
    tag: "column" as const,
    width: "weighted" as const,
    weight,
    background_style: `${color}-50`,
    padding: "8px 10px 8px 10px",
    vertical_align: "top" as const,
    elements: [cardDiv(`<font color='${color}'>**${value}**</font>`)],
  };
}

function cardColumnSet(columns: ReturnType<typeof cardColumn>[]) {
  return {
    tag: "column_set" as const,
    flex_mode: "none" as const,
    horizontal_spacing: "12px",
    background_style: "default",
    columns,
  };
}

/**
 * Cards are structured rather than a rendered text message: the header and
 * rich-text block come from the card template, and the metadata strip is built
 * from its meta templates. Both run through the same placeholder, extraction
 * and privacy pipeline as text messages, so `{{custom.*}}` works here too.
 */
export function renderFeishuCard(notice: Notification, format?: MessageFormat) {
  const color = feishuColors[notice.kind];
  const card = format?.card ?? defaultCardTemplate();
  const title =
    renderTemplateText(notice, format, card.title)
      .replace(/[\r\n]+/g, " ")
      .trim() || `Paseo · ${noticeLabels[notice.kind]}`;
  const body =
    renderTemplateText(notice, format, card.body) ||
    notice.summary ||
    noticeLabels[notice.kind];
  const meta = card.meta
    .map((value) => cardCell(renderTemplateText(notice, format, value), 200))
    .filter(Boolean);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        tag: "plain_text" as const,
        content: truncateJsonText(
          title.replace(/<at\b/gi, "〈at"),
          1000,
        ),
      },
    },
    elements: [
      {
        tag: "div" as const,
        text: {
          tag: "lark_md" as const,
          content: cardMarkdown(body, 8000),
        },
      },
      ...(meta.length
        ? [
            { tag: "hr" as const },
            cardColumnSet(
              meta.map((value, index) =>
                cardColumn(value, color, index === 0 ? 3 : 1),
              ),
            ),
          ]
        : []),
    ],
  };
}
