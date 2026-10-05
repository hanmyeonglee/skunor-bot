export type NotificationTarget = {
  id: string;
  name: string;
};

export type PromptHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

export type ResearchMemoryEntry = {
  question: string;
  answer: string;
  created_at: string;
};

export type DiscordContext = Record<
  string,
  string | number | boolean | string[] | NotificationTarget[] | undefined
>;
