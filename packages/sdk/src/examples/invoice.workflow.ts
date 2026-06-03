// Reference workflow: the "invoice-processing" workflow on the SDK surface.
//
// This is the contract verified "from the developer end". Its twin is
// packages/schema/src/examples/invoice.graph.ts — the same workflow as IR. What
// the compiler emits from that graph should read like this file.
//
// NOTE: lives under src/ so `yarn typecheck` validates it today, and imports the
// surface via a relative path (the package isn't built into dist during typecheck).
// Relocate out of the published surface before the sdk package is cut for npm.

import {
  defineWorkflow,
  trigger,
  ai,
  step,
  state,
  tool,
  type Schema,
} from "../index.js";

interface InvoicePayload {
  invoiceId: string;
  vendor: string;
  amount: number;
  currency: string;
  fileUrl: string;
}

interface InvoiceData {
  total: number;
  dueDate?: string;
  lineItems: { description: string; amount: number }[];
}

interface LedgerResult {
  entryId: string;
  status?: string;
}

// Real workflows would use zod here; the surface only needs a Schema<T>.
const invoicePayload: Schema<InvoicePayload> = { parse: (x) => x as InvoicePayload };
const invoiceData: Schema<InvoiceData> = { parse: (x) => x as InvoiceData };

const postLedger = tool.http<{ data: InvoiceData }, LedgerResult>({
  id: "postLedger",
  name: "Post to ledger",
  method: "POST",
  url: "https://ledger.internal/api/entries",
  headers: { "Content-Type": "application/json" },
  body: (args) => args.data,
  auth: { secret: "LEDGER_API_KEY" },
});

const processed = state<string[]>("processed", { scope: "persistent", initial: [] });

export const invoiceWorkflow = defineWorkflow({
  id: "wf_invoice_processing",
  name: "Invoice Processing",
  on: trigger.onWebhook<InvoicePayload>({
    path: "/hooks/invoice",
    method: "POST",
    schema: invoicePayload,
  }),
  run: async ({ event }) => {
    const data = await ai.generate({
      model: "claude-sonnet-4-6",
      system: "You extract structured data from invoices.",
      prompt: `Extract line items and totals from the invoice at ${event.fileUrl}`,
      schema: invoiceData,
    });

    if (event.amount > 1000) {
      const decision = await step.approval({
        prompt: `Approve invoice ${event.invoiceId}?`,
        timeout: "24h",
        onTimeout: "reject",
      });
      if (!decision.approved) {
        return { entryId: "", status: "rejected" } satisfies LedgerResult;
      }
    }

    const result = await step.run("post-to-ledger", () => postLedger({ data }));
    await processed.append(event.invoiceId);
    return result;
  },
});
