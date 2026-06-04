// Reference fixtures, exported under the "@airun/schema/examples" subpath so the
// builder/app can load real graphs without putting demo data on the main surface.
// These relocate out of the published package when the schema is cut for npm.

export { invoiceGraph } from "./invoice.graph.js";
export { landingGraph } from "./landing.graph.js";
export { contentPipelineGraph } from "./content-pipeline.graph.js";
export { crmAssistantGraph } from "./crm-assistant.graph.js";
export { webAppGraph } from "./web-app.graph.js";
