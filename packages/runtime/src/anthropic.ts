// A real ModelClient backed by the Anthropic Messages API. It is a drop-in for
// stubModelClient: the durable engine calls the same ModelClient port, so wiring
// a real LLM is configuration, not an engine change.
//
// Implemented over global fetch (no SDK dependency). The fetch implementation is
// injectable so the client can be tested without a network.

import type {
  AgentDecision,
  AgentStepRequest,
  ClassifyRequest,
  GenerateRequest,
  ModelClient,
} from "./ports.js";

export interface AnthropicOptions {
  apiKey: string;
  /** Defaults to the public API. Override to point at a proxy/gateway. */
  baseUrl?: string;
  /** Anthropic API version header. Defaults to a known-good pinned value. */
  version?: string;
  /** Upper bound on generated tokens per call. Defaults to 1024. */
  maxTokens?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 1024;

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };

interface MessagesResponse {
  content: ContentBlock[];
  stop_reason: string | null;
}

type Message = { role: "user" | "assistant"; content: string | unknown[] };

interface MessagesRequestBody {
  model: string;
  system?: string;
  messages: Message[];
  tools?: { name: string; description: string; input_schema: unknown }[];
}

function isText(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text";
}

function isToolUse(block: ContentBlock): block is {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
} {
  return block.type === "tool_use";
}

/** Concatenate all text blocks of a response into one string. */
function textOf(res: MessagesResponse): string {
  return res.content
    .filter(isText)
    .map((b) => b.text)
    .join("");
}

/** Strip a Markdown code fence the model may have wrapped JSON in. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? (fenced[1] ?? "").trim() : trimmed;
}

function joinSystem(parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => Boolean(p && p.length > 0));
  return present.length > 0 ? present.join("\n\n") : undefined;
}

export function anthropicModelClient(opts: AnthropicOptions): ModelClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const version = opts.version ?? DEFAULT_VERSION;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(body: MessagesRequestBody): Promise<MessagesResponse> {
    const res = await doFetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": version,
      },
      body: JSON.stringify({ max_tokens: maxTokens, ...body }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as MessagesResponse;
  }

  return {
    async generate(req: GenerateRequest): Promise<unknown> {
      const system =
        req.kind === "object"
          ? joinSystem([req.system, "Respond with a single valid JSON value and no other text."])
          : req.system;
      const res = await call({ model: req.model, system, messages: [{ role: "user", content: req.prompt }] });
      const text = textOf(res);
      if (req.kind !== "object") return text;
      return JSON.parse(stripFences(text));
    },

    async classify(req: ClassifyRequest): Promise<string> {
      const system = joinSystem([
        req.instructions,
        `Classify the input as exactly one of: ${req.labels.join(", ")}. Respond with only the chosen label.`,
      ]);
      const res = await call({ model: req.model, system, messages: [{ role: "user", content: req.input }] });
      const answer = textOf(res).trim().toLowerCase();
      const exact = req.labels.find((l) => l.toLowerCase() === answer);
      const partial = req.labels.find((l) => answer.includes(l.toLowerCase()));
      return exact ?? partial ?? req.labels[0] ?? "";
    },

    async agentStep(req: AgentStepRequest): Promise<AgentDecision> {
      const tools = req.tools.map((t) => ({
        name: t.id,
        description: `Tool ${t.id}`,
        input_schema: { type: "object", additionalProperties: true },
      }));

      const messages: Message[] = [{ role: "user", content: req.prompt }];
      req.history.forEach((turn, i) => {
        const id = `call_${i}`;
        messages.push({
          role: "assistant",
          content: [{ type: "tool_use", id, name: turn.toolId, input: turn.args }],
        });
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(turn.result) }],
        });
      });

      const res = await call({ model: req.model, system: req.system, messages, tools });
      const toolUse = res.content.find(isToolUse);
      if (toolUse) return { kind: "tool", toolId: toolUse.name, args: toolUse.input };
      return { kind: "final", output: textOf(res) };
    },
  };
}
