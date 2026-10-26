import { useState } from "react";
import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsRow, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { noticeLabels, type NoticeKind } from "../shared/config";
import { renderFeishuCard } from "../shared/feishu";
import { notificationExample } from "../shared/notification-example";
import type { MessageFormat } from "../shared/templates";

const colors = {
  green: "#237b42",
  red: "#b42332",
  yellow: "#8a6d00",
  blue: "#245cc0",
};

const tints: Record<string, string> = {
  "grey-50": "#f2f3f5",
  "green-50": "#e8f5ec",
  "red-50": "#fbe9eb",
  "yellow-50": "#fbf3dc",
  "blue-50": "#e8eefb",
};

// Feishu renders color and strong tags itself; the preview shows plain text.
const plain = (text: string) =>
  text
    .replace(/<\/?font[^>]*>/gi, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1");

export function FeishuPreview({
  format,
  theme,
  label = "卡片示例",
}: {
  format: MessageFormat;
  theme: PluginSurfaceProps["theme"];
  label?: string;
}) {
  const [kind, setKind] = useState<NoticeKind>("completed");
  const card = renderFeishuCard(notificationExample(kind), format);
  return (
    <>
      <SettingsRow
        label={label}
        hint="使用内置示例任务渲染，不会发送消息。具体字体、间距以飞书为准。"
      />
      <SettingsSelect
        label="示例通知类型"
        value={kind}
        options={Object.entries(noticeLabels).map(([value, label]) => ({
          value,
          label,
        }))}
        onValueChange={(value) => setKind(value as NoticeKind)}
      />
      <View
        testID="feishu-card-preview"
        style={{
          margin: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            backgroundColor: colors[card.header.template],
            padding: 12,
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "600" }}>
            {card.header.title.content}
          </Text>
        </View>
        <ScrollView
          style={{ maxHeight: 320 }}
          contentContainerStyle={{ padding: 12 }}
          nestedScrollEnabled
        >
          {card.elements.map((element, index) => {
            if (element.tag === "hr")
              return (
                <View
                  key={index}
                  style={{
                    height: 1,
                    marginVertical: 10,
                    backgroundColor: theme.colors.border,
                  }}
                />
              );
            if (element.tag === "column_set")
              return (
                <View
                  key={index}
                  style={{ flexDirection: "row", gap: 8, marginTop: 10 }}
                >
                  {element.columns.map((column, columnIndex) => (
                    <View
                      key={columnIndex}
                      style={{
                        flex: column.weight,
                        minWidth: 0,
                        padding: 8,
                        borderRadius: 4,
                        backgroundColor:
                          tints[column.background_style] ?? tints["grey-50"],
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12,
                          color: theme.colors.foreground,
                        }}
                      >
                        {plain(column.elements[0]!.text.content)}
                      </Text>
                    </View>
                  ))}
                </View>
              );
            return (
              <Text
                key={index}
                selectable
                style={{
                  marginTop: 6,
                  color: theme.colors.foreground,
                }}
              >
                {plain(element.text.content)}
              </Text>
            );
          })}
        </ScrollView>
      </View>
    </>
  );
}
