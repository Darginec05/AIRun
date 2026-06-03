// External effects the runtime depends on, behind small ports so the durable
// core stays testable. The defaults are genuine (real fetch, env-backed
// secrets) except the model client, which is a deterministic stub — wiring a
// real LLM is a drop-in adapter, not a change to the engine.

import type { HttpMethod } from "@airun/sdk";

// --- model client -----------------------------------------------------------

export interface GenerateRequest {
  kind: "text" | "object";
  model: string;
  system?: string;
  prompt: string;
}

export interface ClassifyRequest {
  model: string;
  input: string;
  labels: readonly string[];
  instructions?: string;
}

export interface AgentTurn {
  toolId: string;
  args: unknown;
  result: unknown;
}

export interface AgentStepRequest {
  model: string;
  system?: string;
  prompt: string;
  tools: readonly { id: string }[];
  history: readonly AgentTurn[];
}

export type AgentDecision =
  | { kind: "tool"; toolId: string; args: unknown }
  | { kind: "final"; output: unknown };

export interface ModelClient {
  generate(req: GenerateRequest): Promise<unknown>;
  classify(req: ClassifyRequest): Promise<string>;
  agentStep(req: AgentStepRequest): Promise<AgentDecision>;
}

/**
 * Deterministic stand-in: object generation echoes an empty object, text echoes
 * the prompt, classify picks the first label, and the agent finalizes on its
 * first turn. Enough to exercise the durable engine end to end without a network.
 */
export const stubModelClient: ModelClient = {
  generate: (req) => Promise.resolve(req.kind === "object" ? {} : `[${req.model}] ${req.prompt}`),
  classify: (req) => Promise.resolve(req.labels[0] ?? ""),
  agentStep: () => Promise.resolve({ kind: "final", output: {} }),
};

// --- http client -------------------------------------------------------------

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export const fetchHttpClient: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const init: RequestInit = { method: req.method, headers: req.headers };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    const res = await fetch(req.url, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  },
};

// --- secret resolver ---------------------------------------------------------

export interface SecretResolver {
  resolve(name: string): Promise<string | undefined>;
}

/** Resolves from an explicit map first, then process.env. Never inlined at compile time. */
export function envSecretResolver(overrides: Record<string, string> = {}): SecretResolver {
  return {
    resolve: (name) => Promise.resolve(overrides[name] ?? process.env[name]),
  };
}
