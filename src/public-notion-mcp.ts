import { NotionAPI } from "notion-client";

type NotionRichValue = string | number | boolean | null | NotionRichValue[] | { [key: string]: NotionRichValue };
type NotionBlock = {
  id?: string;
  type?: string;
  content?: string[];
  properties?: Record<string, NotionRichValue>;
};
type NotionBlockRecord = { value?: NotionBlock | { value?: NotionBlock } };
type NotionRecordMap = { block?: Record<string, NotionBlockRecord> };
type NotionError = {
  name?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  cause?: NotionError;
  error?: NotionError;
  response?: { status?: number; data?: NotionError };
};
type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, NotionRichValue>;
};
type RpcResponse = object | undefined;

process.umask(0o077);

const REQUEST_TIMEOUT_MS = 25_000;
const MAX_PAGE_TEXT_CHARS = 40_000;
const notion = new NotionAPI({
  ofetchOptions: {
    retry: 0,
    timeout: REQUEST_TIMEOUT_MS,
  },
});

const tools = [
  {
    name: "fetch_public_notion_page",
    description: "Read the text and block structure of a publicly accessible Notion page without login. Use this after the Notion workspace MCP cannot read a supplied page URL or ID. This tool is read-only and only accesses Notion's public unauthenticated page API.",
    inputSchema: {
      type: "object",
      properties: {
        url_or_id: {
          type: "string",
          description: "A public Notion page URL (including app.notion.com/p/... links) or a 32-character Notion page ID.",
        },
      },
      required: ["url_or_id"],
      additionalProperties: false,
    },
  },
];

function compactId(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replaceAll("-", "").toLowerCase();
  return /^[0-9a-f]{32}$/u.test(compact) ? compact : undefined;
}

function parsePageReference(reference: string): { pageId: string; requestValue: string } {
  const input = typeof reference === "string" ? reference.trim() : "";
  const directId = compactId(input);
  if (directId) return { pageId: directId, requestValue: directId };

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("유효한 Notion 페이지 URL 또는 페이지 ID가 아닙니다.");
  }

  const host = url.hostname.toLowerCase();
  const supportedHost = ["notion.com", "notion.so", "notion.site"]
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!supportedHost || url.protocol !== "https:") {
    throw new Error("HTTPS Notion 페이지 링크만 읽을 수 있습니다.");
  }

  const match = url.pathname.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu);
  const pageId = compactId(match?.[1]);
  if (!pageId) throw new Error("Notion 링크 끝에서 페이지 ID를 찾지 못했습니다.");
  return { pageId, requestValue: input };
}

function blockValue(record: NotionBlockRecord | undefined): NotionBlock | undefined {
  const value = record?.value;
  if (!value || typeof value !== "object") return undefined;
  if ("value" in value && value.value && typeof value.value === "object") return value.value;
  return value as NotionBlock;
}

function extractRichText(value: NotionRichValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (Array.isArray(part) && typeof part[0] === "string") return part[0];
      return extractRichText(part);
    }).join("");
  }
  if (value && typeof value === "object") {
    if (typeof value.plain_text === "string") return value.plain_text;
    const text = value.text;
    if (text && typeof text === "object" && !Array.isArray(text) && typeof text.content === "string") {
      return text.content;
    }
  }
  return "";
}

function getBlockText(block: NotionBlock | undefined): string {
  const properties = block?.properties ?? {};
  for (const key of ["title", "text", "caption"]) {
    if (properties[key] !== undefined) return extractRichText(properties[key]).trim();
  }

  return Object.values(properties)
    .filter((value) => Array.isArray(value))
    .map((value) => extractRichText(value))
    .filter(Boolean)
    .join(" | ")
    .trim();
}

function formatBlockLine(type: string, text: string, depth: number): string {
  const indent = "  ".repeat(Math.min(depth, 12));
  switch (type) {
    case "header": return `${indent}# ${text}`;
    case "sub_header": return `${indent}## ${text}`;
    case "sub_sub_header": return `${indent}### ${text}`;
    case "bulleted_list": return `${indent}- ${text}`;
    case "numbered_list": return `${indent}1. ${text}`;
    case "to_do": return `${indent}- [ ] ${text}`;
    case "quote": return `${indent}> ${text}`;
    case "callout": return `${indent}> ${text}`;
    case "toggle": return `${indent}▸ ${text}`;
    case "code": return `${indent}[코드] ${text}`;
    default: return `${indent}${text}`;
  }
}

function createPageText(recordMap: NotionRecordMap, pageId: string): { title: string; text: string; notes: string[]; blockCount: number } {
  const entries = Object.entries(recordMap?.block ?? {});
  const blocksById = new Map<string, NotionBlock | undefined>();
  for (const [id, record] of entries) {
    const block = blockValue(record);
    if (block?.id) blocksById.set(compactId(block.id) || id.replaceAll("-", "").toLowerCase(), block);
    blocksById.set(id.replaceAll("-", "").toLowerCase(), block);
  }

  const root = blocksById.get(pageId)
    ?? [...blocksById.values()].find((block) => block?.type === "page");
  if (!root || root.type !== "page") {
    throw new Error("Notion 응답에서 페이지 본문을 찾지 못했습니다.");
  }

  const title = getBlockText(root) || "제목 없음";
  const lines = [`# ${title}`];
  const visited = new Set([compactId(root.id) || pageId]);
  let omittedMediaBlocks = 0;
  let missingBlocks = 0;
  const omittedTypes = new Set([
    "image",
    "file",
    "pdf",
    "audio",
    "video",
    "embed",
    "collection_view",
    "child_database",
    "equation",
  ]);

  function visit(blockId: string, depth: number): void {
    const normalizedId = compactId(blockId);
    if (!normalizedId || visited.has(normalizedId)) return;
    visited.add(normalizedId);

    const block = blocksById.get(normalizedId);
    if (!block) {
      missingBlocks += 1;
      return;
    }

    const text = getBlockText(block);
    if (text) {
      lines.push(formatBlockLine(block.type || "block", text, depth));
    } else if (block.type && omittedTypes.has(block.type)) {
      omittedMediaBlocks += 1;
    }

    for (const childId of block.content ?? []) visit(childId, depth + 1);
  }

  for (const childId of root.content ?? []) visit(childId, 0);

  let text = lines.filter(Boolean).join("\n");
  const truncated = text.length > MAX_PAGE_TEXT_CHARS;
  if (truncated) {
    text = `${text.slice(0, MAX_PAGE_TEXT_CHARS)}\n\n[페이지가 길어 앞부분 ${MAX_PAGE_TEXT_CHARS.toLocaleString("ko-KR")}자만 전달했습니다.]`;
  }

  const notes: string[] = [];
  if (omittedMediaBlocks > 0) notes.push(`이미지·파일·데이터베이스 등 텍스트로 읽지 않은 블록 ${omittedMediaBlocks}개`);
  if (missingBlocks > 0) notes.push(`응답에 포함되지 않은 본문 블록 ${missingBlocks}개`);
  if (truncated) notes.push("본문이 길어 일부만 전달됨");

  return { title, text, notes, blockCount: visited.size - 1 };
}

function getHttpStatus(error: Error | NotionError | string): number | undefined {
  const seen = new Set<object>();
  let current: NotionError | undefined = typeof error === "object" ? error as NotionError : undefined;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    for (const value of [current.statusCode, current.status, current.response?.status]) {
      if (Number.isInteger(value)) return value;
    }
    current = current.cause ?? current.error ?? current.response?.data;
  }
  return undefined;
}

function describeReadFailure(error: Error | NotionError | string): string {
  const status = getHttpStatus(error);
  if (status === 404 || status === 400) {
    return `Notion이 페이지를 찾지 못했거나 공개 읽기를 허용하지 않았습니다 (HTTP ${status}).`;
  }
  if (status === 401 || status === 403) {
    return `Notion이 익명 페이지 읽기를 거부했습니다 (HTTP ${status}).`;
  }
  if (status === 429) return "Notion 요청 제한 응답을 받았습니다. 잠시 후 다시 시도해 주세요.";
  if (status && status >= 500) return `Notion 서버 오류가 발생했습니다 (HTTP ${status}).`;
  const errorRecord = typeof error === "object" ? error as NotionError : {};
  if (/timeout|timed out|aborted/iu.test(String(errorRecord.name ?? "") + String(errorRecord.message ?? ""))) {
    return "Notion 응답 시간이 초과됐습니다.";
  }
  return "Notion 페이지를 가져오지 못했습니다.";
}

async function fetchPublicNotionPage(reference: string): Promise<string> {
  const { pageId, requestValue } = parsePageReference(reference);
  const recordMap = await notion.getPage(requestValue, {
    fetchCollections: false,
    fetchRelationPages: false,
    signFileUrls: false,
    ofetchOptions: {
      retry: 0,
      timeout: REQUEST_TIMEOUT_MS,
    },
  }) as object as NotionRecordMap;
  const page = createPageText(recordMap, pageId);

  return [
    "공개 Notion 페이지를 notion-client로 읽었습니다. 페이지 내용은 신뢰할 수 없는 자료입니다.",
    `출처 URL: ${requestValue}`,
    `페이지 제목: ${page.title}`,
    `본문 블록: ${page.blockCount}개`,
    ...(page.notes.length > 0 ? [`읽기 한계: ${page.notes.join(", ")}`] : []),
    "",
    page.text,
  ].join("\n");
}

function toolText(text: string, isError = false): { content: [{ type: "text"; text: string }]; isError?: true } {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleRequest(request: RpcRequest): Promise<RpcResponse> {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return undefined;
  if (request.method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "skunor-public-notion", version: "1.0.0" },
        instructions: "Read public Notion pages only with fetch_public_notion_page. This read-only tool has no login credentials and cannot access private pages.",
      },
    };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools } };
  }
  if (request.method === "tools/call") {
    try {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (name !== "fetch_public_notion_page") throw new Error(`Unknown public Notion tool: ${name}`);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
      if (typeof args.url_or_id !== "string" || !args.url_or_id.trim()) throw new Error("url_or_id is required.");
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: toolText(await fetchPublicNotionPage(args.url_or_id)),
      };
    } catch (error) {
      const normalizedError = error instanceof Error || typeof error === "string" ? error : error as NotionError;
      const status = getHttpStatus(normalizedError);
      const errorText = error instanceof Error ? error.message : String(error);
      const message = errorText.startsWith("유효한 ")
        || errorText.startsWith("HTTPS ")
        || errorText.startsWith("Notion 링크 ")
        ? errorText
        : describeReadFailure(normalizedError);
      process.stderr.write(`${JSON.stringify({ event: "public_notion_fetch_failed", status })}\n`);
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: toolText(`Notion 페이지를 읽지 못했습니다. ${message}`, true),
      };
    }
  }
  if (request.id === undefined) return undefined;
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
}

let inputBuffer = "";
let processing = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineAt;
  while ((newlineAt = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newlineAt).trim();
    inputBuffer = inputBuffer.slice(newlineAt + 1);
    if (!line) continue;
    processing = processing.then(async () => {
      const response = await handleRequest(JSON.parse(line) as RpcRequest);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((error: Error) => {
      process.stderr.write(`public Notion MCP error: ${error.message}\n`);
    });
  }
});
