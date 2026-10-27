import { failureLabels, noticeLabels } from "./config";
import type { Notification } from "./contracts";
import {
  compilePattern,
  defaultMessageTemplate,
  type CardTemplate,
  type MessageTemplate,
} from "./template-schema";

export type MessageFormat = {
  template: MessageTemplate;
  includePreview: boolean;
  previewCharacters: number;
  card?: CardTemplate;
};

function limit(text: string, size: number): string {
  return text.length <= size
    ? text
    : text.slice(0, size - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

export function visibleNotification(
  notice: Notification,
  format?: MessageFormat,
): Notification {
  if (!format) return notice;
  const { preview, ...metadata } = notice;
  return format.includePreview && preview
    ? {
        ...metadata,
        preview: Array.from(preview)
          .slice(0, format.previewCharacters)
          .join(""),
      }
    : metadata;
}

function localFields(value: number) {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  };
}

// Placeholder substitution shared by the message template and card template.
// Lines that only held empty placeholders are dropped; authored blank lines and
// literal labels survive, and substituted values are never expanded again.
function fillTemplate(
  text: string,
  values: ReadonlyMap<string, string>,
): string {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const result = line.replace(
        /\{\{([^{}]*)\}\}/g,
        (_, key: string) => values.get(key.trim()) ?? "",
      );
      return line.includes("{{") && !result.trim() ? [] : [result];
    })
    .join("\n")
    .trim();
}

function templateValues(safe: Notification, template: MessageTemplate) {
  const local = localFields(safe.createdAt);
  const values = new Map<string, string>(
    Object.entries({
      event: noticeLabels[safe.kind],
      event_type: safe.kind,
      title: safe.title,
      hostname: safe.hostname ?? "",
      project_name: safe.projectName ?? "",
      workspace_name: safe.workspaceName ?? "",
      session_title: safe.sessionTitle ?? "",
      summary: safe.summary,
      preview: safe.preview ?? "",
      session_id: safe.agentId,
      workspace_id: safe.workspaceId ?? "",
      schedule_id: safe.scheduleId ?? "",
      provider: safe.provider,
      failure: safe.failure ? failureLabels[safe.failure] : "",
      failure_type: safe.failure ?? "",
      attempts: String(safe.attempts),
      recovery: safe.attempts > 0 ? `自动恢复尝试：${safe.attempts} 次` : "",
      created_at: new Date(safe.createdAt).toISOString(),
      time: local.time,
      date: local.date,
      notification_id: safe.id,
    }),
  );
  const extractions = template.rules.map((rule) => {
    // Each source is already privacy-filtered. Bound work independently of any
    // old journal or imported data. No user-supplied expression uses JS RegExp.
    const source = Array.from(safe[rule.source] ?? "")
      .slice(0, 4000)
      .join("");
    const matcher = compilePattern(rule.pattern, rule.flags).matcher(source);
    const capture = source && matcher.find() ? matcher.group(rule.group) : null;
    const matched = capture != null;
    const value = matched ? capture : rule.fallback;
    values.set(`custom.${rule.name}`, value);
    return { name: rule.name, matched, value };
  });
  return { values, extractions };
}

export function renderNotification(
  notice: Notification,
  format?: MessageFormat,
) {
  const safe = visibleNotification(notice, format);
  const template = format?.template ?? defaultMessageTemplate();
  const { values, extractions } = templateValues(safe, template);
  // Empty dynamic output still needs to be accepted by every transport.
  const title = limit(
    fillTemplate(template.title, values)
      .replace(/[\r\n]+/g, " ")
      .trim() || `Paseo · ${noticeLabels[safe.kind]}`,
    200,
  );
  const body = limit(
    fillTemplate(template.body, values) ||
      safe.summary ||
      noticeLabels[safe.kind],
    16_000,
  );
  return { title, body, text: `${title}\n${body}`, extractions };
}

/**
 * Render one template string (a card title, body or metadata cell) with the
 * same placeholders, extraction rules and privacy filtering as the message
 * template. Card fields fall back on their own, so no title/body defaults are
 * applied here.
 */
export function renderTemplateText(
  notice: Notification,
  format: MessageFormat | undefined,
  text: string,
): string {
  const safe = visibleNotification(notice, format);
  const template = format?.template ?? defaultMessageTemplate();
  const { values } = templateValues(safe, template);
  return fillTemplate(text, values);
}
