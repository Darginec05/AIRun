// The inspector: edits the selected node's friendly name, its config fields, and
// its list config — router routes, conditional branches, and human-input fields
// (add / remove / rename). Adding or removing a list item re-derives the node's
// ports, so the matching route:* / branch:* / fields.* port appears or disappears
// on the canvas at once.
//
// Config values are Bindings, and every Bound field carries a source switcher:
// literal / ref (another node's output + path) / var (a workflow variable) /
// template (text + nested-binding segments). The ref/var pickers draw their
// candidates from the BindingContext the canvas supplies. Router routes and
// conditional branches carry a recursive condition editor (compare / and / or /
// not / unsafe-expr) over the IR Condition.

import { useRef, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import type {
  Binding,
  Condition,
  ConditionalBranch,
  DataType,
  Duration,
  HttpMethod,
  InputField,
  RouteCase,
  TemplateSegment,
  TriggerSpec,
  WorkflowNode,
} from "@airun/schema";
import { NODE_TYPES } from "@airun/node-registry";

/** Candidates the ref / var pickers offer, supplied by the canvas. */
export interface BindingContext {
  nodes: ReadonlyArray<{ id: string; label: string }>;
  variables: ReadonlyArray<string>;
}

export interface InspectorProps {
  node: WorkflowNode;
  onChange: (next: WorkflowNode) => void;
  ctx: BindingContext;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const litStr = (value: string): Binding => ({ kind: "literal", value });
const litNum = (value: number): Binding => ({ kind: "literal", value });

type BindingKind = Binding["kind"];
type LiteralKind = "text" | "multiline" | "number";
const BINDING_KINDS = ["literal", "ref", "var", "template"] as const;

// Switching a Bound field's source seeds a fresh binding of the chosen kind,
// reusing the previous value when the kinds match so a stray click is non-destructive.
// The literal seed matches the field's literal type (0 for numbers, "" for text).
function seedBinding(kind: BindingKind, prev: Binding | undefined, ctx: BindingContext, literal: LiteralKind): Binding {
  switch (kind) {
    case "literal":
      return prev?.kind === "literal" ? prev : { kind: "literal", value: literal === "number" ? 0 : "" };
    case "ref":
      return prev?.kind === "ref" ? prev : { kind: "ref", nodeId: ctx.nodes[0]?.id ?? "" };
    case "var":
      return prev?.kind === "var" ? prev : { kind: "var", name: ctx.variables[0] ?? "" };
    case "template":
      return prev?.kind === "template" ? prev : { kind: "template", segments: [{ kind: "text", value: "" }] };
  }
}

// Scalar data types offered for human-input fields; the `{kind:"schema"}`
// variant needs a schema picker and lands in a later slice.
const DATA_TYPES = ["string", "number", "boolean", "json", "conversation", "any"] as const;
type ScalarDataType = (typeof DATA_TYPES)[number];

// A schema-typed field has no scalar option yet, so the select reads it as "json".
const fieldType = (t: DataType): ScalarDataType => (typeof t === "string" ? t : "json");

// A short, unique id for a new list item (e.g. "r1", "b3", "f2").
function freshId(prefix: string, taken: ReadonlySet<string>): string {
  let n = taken.size + 1;
  let id = `${prefix}${n}`;
  while (taken.has(id)) id = `${prefix}${(n += 1)}`;
  return id;
}

// A neutral seed condition so a new branch / route is valid the moment it exists.
const defaultCondition = (): Condition => ({
  kind: "compare",
  op: "eq",
  left: { kind: "literal", value: "" },
  right: { kind: "literal", value: "" },
});

const CONDITION_KINDS = ["compare", "and", "or", "not", "expr"] as const;
const COMPARE_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"] as const;

// Switching a condition's kind keeps the existing children where it can: and/or
// trade their child lists, not wraps the current condition, and the rest of the
// transitions wrap the previous condition rather than discarding it.
function switchCondition(kind: Condition["kind"], prev: Condition): Condition {
  switch (kind) {
    case "compare":
      return prev.kind === "compare" ? prev : defaultCondition();
    case "and":
      return prev.kind === "and" ? prev : { kind: "and", conditions: prev.kind === "or" ? prev.conditions : [prev] };
    case "or":
      return prev.kind === "or" ? prev : { kind: "or", conditions: prev.kind === "and" ? prev.conditions : [prev] };
    case "not":
      return prev.kind === "not" ? prev : { kind: "not", condition: prev };
    case "expr":
      return prev.kind === "expr" ? prev : { kind: "expr", unsafe: true, language: "js", source: "" };
  }
}

function defaultTrigger(kind: TriggerSpec["kind"]): TriggerSpec {
  switch (kind) {
    case "event":
      return { kind: "event", eventName: "" };
    case "schedule":
      return { kind: "schedule", cron: "0 0 * * *" };
    case "webhook":
      return { kind: "webhook", path: "/hook", method: "POST" };
  }
}

// --- field primitives ------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="wf-field">
      <span className="wf-field-label">{label}</span>
      {children}
    </label>
  );
}

function Note({ children }: { children: ReactNode }): ReactElement {
  return <p className="wf-field-note">{children}</p>;
}

// Like Field, but a plain div: binding fields hold several controls (source tabs,
// selects, inputs), and a <label> may legally associate with only one of them.
function FieldBox({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="wf-field">
      <span className="wf-field-label">{label}</span>
      {children}
    </div>
  );
}

function BindingSourceTabs({
  active,
  optional,
  disabled,
  onSwitch,
}: {
  active: BindingKind | "none";
  optional?: boolean;
  disabled?: ReadonlySet<BindingKind>;
  onSwitch: (k: BindingKind | "none") => void;
}): ReactElement {
  const kinds: ReadonlyArray<BindingKind | "none"> = optional ? ["none", ...BINDING_KINDS] : BINDING_KINDS;
  return (
    <div className="wf-bind-tabs" role="tablist">
      {kinds.map((k) => {
        // Don't disable the active kind itself, so a binding loaded from the
        // graph stays selectable even when its candidates are momentarily empty.
        const off = k !== "none" && k !== active && (disabled?.has(k) ?? false);
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === active}
            disabled={off}
            className={`wf-bind-tab${k === active ? " is-active" : ""}`}
            onClick={() => onSwitch(k)}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
}

function LiteralEditor({
  bound,
  literal,
  placeholder,
  onChange,
}: {
  bound: Extract<Binding, { kind: "literal" }>;
  literal: "text" | "multiline" | "number";
  placeholder?: string;
  onChange: (b: Binding | undefined) => void;
}): ReactElement {
  if (literal === "number") {
    const value = typeof bound.value === "number" ? String(bound.value) : "";
    const handle = (e: ChangeEvent<HTMLInputElement>): void => {
      const raw = e.target.value;
      if (raw === "") return onChange(undefined);
      const n = Number(raw);
      if (Number.isFinite(n)) onChange(litNum(n));
    };
    return <input className="wf-input" type="number" value={value} onChange={handle} />;
  }
  const value = typeof bound.value === "string" ? bound.value : "";
  const handle = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => onChange(litStr(e.target.value));
  return literal === "multiline" ? (
    <textarea className="wf-input wf-textarea" rows={3} value={value} placeholder={placeholder} onChange={handle} />
  ) : (
    <input className="wf-input" value={value} placeholder={placeholder} onChange={handle} />
  );
}

function RefEditor({
  bound,
  onChange,
  ctx,
}: {
  bound: Extract<Binding, { kind: "ref" }>;
  onChange: (b: Binding) => void;
  ctx: BindingContext;
}): ReactElement {
  return (
    <div className="wf-bind-row">
      <select
        className="wf-input wf-select"
        value={bound.nodeId}
        onChange={(e) => onChange({ ...bound, nodeId: e.target.value })}
      >
        {!ctx.nodes.some((n) => n.id === bound.nodeId) && <option value={bound.nodeId}>{bound.nodeId || "—"}</option>}
        {ctx.nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.label} — {n.id}
          </option>
        ))}
      </select>
      <input
        className="wf-input"
        placeholder="path (optional)"
        value={bound.path ?? ""}
        onChange={(e) => onChange({ ...bound, path: e.target.value || undefined })}
      />
    </div>
  );
}

function VarEditor({
  bound,
  onChange,
  ctx,
}: {
  bound: Extract<Binding, { kind: "var" }>;
  onChange: (b: Binding) => void;
  ctx: BindingContext;
}): ReactElement {
  if (ctx.variables.length === 0) return <Note>No workflow variables are declared yet.</Note>;
  return (
    <select
      className="wf-input wf-select"
      value={bound.name}
      onChange={(e) => onChange({ kind: "var", name: e.target.value })}
    >
      {!ctx.variables.includes(bound.name) && <option value={bound.name}>{bound.name || "—"}</option>}
      {ctx.variables.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

function TemplateEditor({
  segments,
  onChange,
  ctx,
}: {
  segments: TemplateSegment[];
  onChange: (segments: TemplateSegment[]) => void;
  ctx: BindingContext;
}): ReactElement {
  // Stable per-row keys: segments are plain IR objects with no id and are
  // replaced on every keystroke, so an index/identity key would remount rows and
  // steal focus. We keep a key list aligned to segments and splice it in lockstep
  // with structural edits.
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < segments.length) keys.current.push(nextKey.current++);
  keys.current.length = segments.length;

  const setAt = (i: number, seg: TemplateSegment): void => onChange(segments.map((s, j) => (j === i ? seg : s)));
  const removeAt = (i: number): void => {
    keys.current.splice(i, 1);
    onChange(segments.filter((_, j) => j !== i));
  };
  const addSeg = (seg: TemplateSegment): void => {
    keys.current.push(nextKey.current++);
    onChange([...segments, seg]);
  };
  return (
    <div className="wf-tpl">
      {segments.map((seg, i) => (
        <div className="wf-tpl-seg" key={keys.current[i]}>
          {seg.kind === "text" ? (
            <input
              className="wf-input"
              placeholder="text"
              value={seg.value}
              onChange={(e) => setAt(i, { kind: "text", value: e.target.value })}
            />
          ) : (
            <div className="wf-tpl-expr">
              <BindingControl
                bound={seg.binding}
                ctx={ctx}
                onChange={(b) => setAt(i, { kind: "expr", binding: b ?? { kind: "literal", value: "" } })}
              />
            </div>
          )}
          <button type="button" className="wf-list-remove" title="Remove" onClick={() => removeAt(i)}>
            ✕
          </button>
        </div>
      ))}
      <div className="wf-tpl-add">
        <button type="button" className="wf-list-add" onClick={() => addSeg({ kind: "text", value: "" })}>
          + text
        </button>
        <button
          type="button"
          className="wf-list-add"
          onClick={() => addSeg({ kind: "expr", binding: { kind: "literal", value: "" } })}
        >
          + expr
        </button>
      </div>
    </div>
  );
}

// Tabs + the editor for whichever binding source is active. No label/Field
// wrapper, so it nests inside template expr segments as well as the field forms.
function BindingControl({
  bound,
  onChange,
  ctx,
  optional,
  literal = "text",
  placeholder,
}: {
  bound: Binding | undefined;
  onChange: (b: Binding | undefined) => void;
  ctx: BindingContext;
  optional?: boolean;
  literal?: LiteralKind;
  placeholder?: string;
}): ReactElement {
  const active: BindingKind | "none" = bound?.kind ?? (optional ? "none" : "literal");
  const onSwitch = (k: BindingKind | "none"): void =>
    onChange(k === "none" ? undefined : seedBinding(k, bound, ctx, literal));
  const disabled = new Set<BindingKind>();
  if (ctx.nodes.length === 0) disabled.add("ref");
  if (ctx.variables.length === 0) disabled.add("var");
  return (
    <div className="wf-bind">
      <BindingSourceTabs active={active} optional={optional} disabled={disabled} onSwitch={onSwitch} />
      {bound?.kind === "literal" && (
        <LiteralEditor bound={bound} literal={literal} placeholder={placeholder} onChange={onChange} />
      )}
      {bound?.kind === "ref" && <RefEditor bound={bound} onChange={onChange} ctx={ctx} />}
      {bound?.kind === "var" && <VarEditor bound={bound} onChange={onChange} ctx={ctx} />}
      {bound?.kind === "template" && (
        <TemplateEditor segments={bound.segments} ctx={ctx} onChange={(segments) => onChange({ kind: "template", segments })} />
      )}
    </div>
  );
}

function BoundTextField({
  label,
  bound,
  onChange,
  ctx,
  multiline,
  placeholder,
  optional,
}: {
  label: string;
  bound: Binding | undefined;
  onChange: (b: Binding | undefined) => void;
  ctx: BindingContext;
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
}): ReactElement {
  return (
    <FieldBox label={label}>
      <BindingControl
        bound={optional ? bound : (bound ?? litStr(""))}
        ctx={ctx}
        optional={optional}
        literal={multiline ? "multiline" : "text"}
        placeholder={placeholder}
        onChange={(b) => onChange(optional ? b : (b ?? litStr("")))}
      />
    </FieldBox>
  );
}

function BoundNumberField({
  label,
  bound,
  onChange,
  ctx,
}: {
  label: string;
  bound: Binding | undefined;
  onChange: (b: Binding | undefined) => void;
  ctx: BindingContext;
}): ReactElement {
  return (
    <FieldBox label={label}>
      <BindingControl bound={bound} onChange={onChange} ctx={ctx} optional literal="number" />
    </FieldBox>
  );
}

// Recursive predicate editor: a kind switcher (compare / and / or / not / expr)
// over the IR `Condition` union. compare edits an operator + two Bindings (reusing
// BindingControl); and/or hold a nested list; not wraps one child; expr is the
// sandboxed JS escape hatch.
function ConditionEditor({
  condition,
  onChange,
  ctx,
}: {
  condition: Condition;
  onChange: (c: Condition) => void;
  ctx: BindingContext;
}): ReactElement {
  // Stable keys for the and/or child list, same approach as TemplateEditor. The
  // hook runs unconditionally; children is empty for the non-list kinds.
  const children = condition.kind === "and" || condition.kind === "or" ? condition.conditions : [];
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < children.length) keys.current.push(nextKey.current++);
  keys.current.length = children.length;

  const body = ((): ReactNode => {
    switch (condition.kind) {
      case "compare":
        return (
          <>
            <SelectField
              label="Operator"
              value={condition.op}
              options={COMPARE_OPS}
              onChange={(op) => onChange({ ...condition, op })}
            />
            <FieldBox label="Left">
              <BindingControl bound={condition.left} ctx={ctx} onChange={(b) => onChange({ ...condition, left: b ?? litStr("") })} />
            </FieldBox>
            <FieldBox label="Right">
              <BindingControl bound={condition.right} ctx={ctx} onChange={(b) => onChange({ ...condition, right: b ?? litStr("") })} />
            </FieldBox>
          </>
        );
      case "and":
      case "or": {
        const conds = condition.conditions;
        const setChild = (i: number, next: Condition): void =>
          onChange({ ...condition, conditions: conds.map((c, j) => (j === i ? next : c)) });
        const removeChild = (i: number): void => {
          keys.current.splice(i, 1);
          onChange({ ...condition, conditions: conds.filter((_, j) => j !== i) });
        };
        const addChild = (): void => {
          keys.current.push(nextKey.current++);
          onChange({ ...condition, conditions: [...conds, defaultCondition()] });
        };
        return (
          <div className="wf-list">
            {conds.map((c, i) => (
              <div className="wf-cond-child" key={keys.current[i]}>
                <ConditionEditor condition={c} ctx={ctx} onChange={(next) => setChild(i, next)} />
                <button type="button" className="wf-list-remove" title="Remove" onClick={() => removeChild(i)}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="wf-list-add" onClick={addChild}>
              + condition
            </button>
          </div>
        );
      }
      case "not":
        return (
          <div className="wf-cond-child">
            <ConditionEditor condition={condition.condition} ctx={ctx} onChange={(c) => onChange({ kind: "not", condition: c })} />
          </div>
        );
      case "expr":
        return (
          <>
            <Note>Unsafe JS expression — sandboxed at runtime.</Note>
            <textarea
              className="wf-input wf-textarea"
              rows={3}
              placeholder="item.total > 1000"
              value={condition.source}
              onChange={(e) => onChange({ kind: "expr", unsafe: true, language: "js", source: e.target.value })}
            />
          </>
        );
    }
  })();

  return (
    <div className="wf-cond">
      <div className="wf-bind-tabs" role="tablist">
        {CONDITION_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === condition.kind}
            className={`wf-bind-tab${k === condition.kind ? " is-active" : ""}`}
            onClick={() => onChange(switchCondition(k, condition))}
          >
            {k}
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}

function PlainTextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): ReactElement {
  return (
    <Field label={label}>
      <input className="wf-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function PlainNumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}): ReactElement {
  const handle = (e: ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value;
    if (raw === "") return onChange(undefined);
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(n);
  };
  return (
    <Field label={label}>
      <input className="wf-input" type="number" value={value === undefined ? "" : String(value)} onChange={handle} />
    </Field>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}): ReactElement {
  return (
    <Field label={label}>
      <select className="wf-input wf-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </Field>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): ReactElement {
  return (
    <label className="wf-field wf-field-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="wf-field-label">{label}</span>
    </label>
  );
}

// --- list primitives -------------------------------------------------------

function ListEditor({
  label,
  addLabel,
  onAdd,
  children,
}: {
  label: string;
  addLabel: string;
  onAdd: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="wf-list">
      <span className="wf-field-label">{label}</span>
      {children}
      <button type="button" className="wf-list-add" onClick={onAdd}>
        + {addLabel}
      </button>
    </div>
  );
}

function ListRow({ children, onRemove }: { children: ReactNode; onRemove: () => void }): ReactElement {
  return (
    <div className="wf-list-row">
      <div className="wf-list-row-fields">{children}</div>
      <button type="button" className="wf-list-remove" title="Remove" onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

// --- per-type forms --------------------------------------------------------

function NodeForm({ node, onChange, ctx }: InspectorProps): ReactElement {
  switch (node.type) {
    case "trigger": {
      const t = node.config.trigger;
      const setT = (trigger: TriggerSpec): void => onChange({ ...node, config: { trigger } });
      return (
        <>
          <SelectField
            label="Kind"
            value={t.kind}
            options={["event", "schedule", "webhook"] as const}
            onChange={(kind) => setT(defaultTrigger(kind))}
          />
          {t.kind === "event" && (
            <PlainTextField label="Event name" value={t.eventName} onChange={(eventName) => setT({ ...t, eventName })} />
          )}
          {t.kind === "schedule" && (
            <>
              <PlainTextField label="Cron" value={t.cron} onChange={(cron) => setT({ ...t, cron })} />
              <PlainTextField
                label="Timezone"
                value={t.timezone ?? ""}
                onChange={(v) => setT({ ...t, timezone: v || undefined })}
              />
            </>
          )}
          {t.kind === "webhook" && (
            <>
              <PlainTextField label="Path" value={t.path} onChange={(path) => setT({ ...t, path })} />
              <SelectField
                label="Method"
                value={t.method}
                options={HTTP_METHODS}
                onChange={(method: HttpMethod) => setT({ ...t, method })}
              />
            </>
          )}
        </>
      );
    }

    case "llm": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <BoundTextField label="Model" bound={c.model} ctx={ctx} onChange={(model) => set({ model })} />
          <BoundTextField label="Prompt" multiline bound={c.prompt} ctx={ctx} onChange={(prompt) => set({ prompt })} />
          <BoundNumberField label="Temperature" bound={c.temperature} ctx={ctx} onChange={(temperature) => set({ temperature })} />
          <BoundNumberField label="Max tokens" bound={c.maxTokens} ctx={ctx} onChange={(maxTokens) => set({ maxTokens })} />
        </>
      );
    }

    case "router": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      const setRoute = (id: string, patch: Partial<RouteCase>): void =>
        set({ routes: c.routes.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
      const addRoute = (): void => {
        const taken = new Set(c.routes.map((r) => r.id));
        const route: RouteCase =
          c.mode === "condition"
            ? { id: freshId("r", taken), name: "New route", condition: defaultCondition() }
            : { id: freshId("r", taken), name: "New route", description: "" };
        set({ routes: [...c.routes, route] });
      };
      const removeRoute = (id: string): void =>
        set({
          routes: c.routes.filter((r) => r.id !== id),
          fallbackRouteId: c.fallbackRouteId === id ? undefined : c.fallbackRouteId,
        });
      return (
        <>
          <SelectField
            label="Mode"
            value={c.mode}
            options={["condition", "classify"] as const}
            onChange={(mode) => set({ mode })}
          />
          {c.mode === "classify" && (
            <BoundTextField label="Model" bound={c.model} ctx={ctx} onChange={(model) => set({ model })} />
          )}
          <ListEditor label="Routes" addLabel="add route" onAdd={addRoute}>
            {c.routes.map((r) => (
              <ListRow key={r.id} onRemove={() => removeRoute(r.id)}>
                <PlainTextField label="Name" value={r.name} onChange={(name) => setRoute(r.id, { name })} />
                {c.mode === "classify" && (
                  <PlainTextField
                    label="Description"
                    value={r.description ?? ""}
                    placeholder="When to pick this route"
                    onChange={(v) => setRoute(r.id, { description: v || undefined })}
                  />
                )}
                {c.mode === "condition" && (
                  <FieldBox label="Condition">
                    <ConditionEditor
                      condition={r.condition ?? defaultCondition()}
                      ctx={ctx}
                      onChange={(condition) => setRoute(r.id, { condition })}
                    />
                  </FieldBox>
                )}
              </ListRow>
            ))}
          </ListEditor>
        </>
      );
    }

    case "tool": {
      const c = node.config;
      return (
        <PlainTextField
          label="Tool ID"
          value={c.toolId}
          onChange={(toolId) => onChange({ ...node, config: { ...c, toolId } })}
        />
      );
    }

    case "agentLoop": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <BoundTextField label="Model" bound={c.model} ctx={ctx} onChange={(model) => set({ model })} />
          <BoundTextField label="Prompt" multiline bound={c.prompt} ctx={ctx} onChange={(prompt) => set({ prompt })} />
        </>
      );
    }

    case "parallel": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <SelectField
            label="Mode"
            value={c.mode}
            options={["branches", "map"] as const}
            onChange={(mode) => set({ mode })}
          />
          <PlainNumberField
            label="Max concurrency"
            value={c.maxConcurrency}
            onChange={(maxConcurrency) => set({ maxConcurrency })}
          />
          {c.mode === "map" && (
            <PlainTextField label="Item var" value={c.itemVar ?? ""} onChange={(v) => set({ itemVar: v || undefined })} />
          )}
        </>
      );
    }

    case "conditional": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      const setBranch = (id: string, patch: Partial<ConditionalBranch>): void =>
        set({ branches: c.branches.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
      const addBranch = (): void => {
        const taken = new Set(c.branches.map((b) => b.id));
        const branch: ConditionalBranch = { id: freshId("b", taken), name: "New branch", condition: defaultCondition() };
        set({ branches: [...c.branches, branch] });
      };
      const removeBranch = (id: string): void => set({ branches: c.branches.filter((b) => b.id !== id) });
      return (
        <>
          <ListEditor label="Branches" addLabel="add branch" onAdd={addBranch}>
            {c.branches.map((b) => (
              <ListRow key={b.id} onRemove={() => removeBranch(b.id)}>
                <PlainTextField
                  label="Name"
                  value={b.name ?? ""}
                  onChange={(v) => setBranch(b.id, { name: v || undefined })}
                />
                <FieldBox label="Condition">
                  <ConditionEditor condition={b.condition} ctx={ctx} onChange={(condition) => setBranch(b.id, { condition })} />
                </FieldBox>
              </ListRow>
            ))}
          </ListEditor>
          <CheckboxField label="Has else branch" checked={c.hasElse} onChange={(hasElse) => set({ hasElse })} />
        </>
      );
    }

    case "loop": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <SelectField
            label="Mode"
            value={c.mode}
            options={["while", "forEach", "count"] as const}
            onChange={(mode) => set({ mode })}
          />
          {c.mode === "count" && (
            <BoundNumberField label="Count" bound={c.count} ctx={ctx} onChange={(count) => set({ count })} />
          )}
          {c.mode === "forEach" && (
            <PlainTextField label="Item var" value={c.itemVar ?? ""} onChange={(v) => set({ itemVar: v || undefined })} />
          )}
          <PlainNumberField
            label="Max iterations"
            value={c.maxIterations}
            onChange={(maxIterations) => set({ maxIterations })}
          />
        </>
      );
    }

    case "humanApproval": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <BoundTextField label="Prompt" multiline bound={c.prompt} ctx={ctx} onChange={(prompt) => set({ prompt })} />
          <BoundTextField label="Assignee" optional bound={c.assignee} ctx={ctx} onChange={(assignee) => set({ assignee })} />
          <PlainTextField
            label="Timeout"
            value={c.timeout ?? ""}
            placeholder="30s"
            onChange={(v) => set({ timeout: v ? (v as Duration) : undefined })}
          />
          <Field label="On timeout">
            <select
              className="wf-input wf-select"
              value={c.onTimeout ?? ""}
              onChange={(e) =>
                set({ onTimeout: e.target.value === "" ? undefined : (e.target.value as "approve" | "reject" | "escalate") })
              }
            >
              <option value="">—</option>
              <option value="approve">approve</option>
              <option value="reject">reject</option>
              <option value="escalate">escalate</option>
            </select>
          </Field>
        </>
      );
    }

    case "humanInput": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      const setField = (id: string, patch: Partial<InputField>): void =>
        set({ fields: c.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
      const addField = (): void => {
        const taken = new Set(c.fields.map((f) => f.id));
        const field: InputField = { id: freshId("f", taken), name: "New field", dataType: "string" };
        set({ fields: [...c.fields, field] });
      };
      const removeField = (id: string): void => set({ fields: c.fields.filter((f) => f.id !== id) });
      return (
        <>
          <BoundTextField label="Prompt" multiline bound={c.prompt} ctx={ctx} onChange={(prompt) => set({ prompt })} />
          <BoundTextField label="Assignee" optional bound={c.assignee} ctx={ctx} onChange={(assignee) => set({ assignee })} />
          <PlainTextField
            label="Timeout"
            value={c.timeout ?? ""}
            placeholder="5m"
            onChange={(v) => set({ timeout: v ? (v as Duration) : undefined })}
          />
          <ListEditor label="Fields" addLabel="add field" onAdd={addField}>
            {c.fields.map((f) => (
              <ListRow key={f.id} onRemove={() => removeField(f.id)}>
                <PlainTextField label="Name" value={f.name} onChange={(name) => setField(f.id, { name })} />
                <SelectField
                  label="Type"
                  value={fieldType(f.dataType)}
                  options={DATA_TYPES}
                  onChange={(dataType) => setField(f.id, { dataType })}
                />
                <CheckboxField
                  label="Required"
                  checked={f.required ?? false}
                  onChange={(v) => setField(f.id, { required: v || undefined })}
                />
              </ListRow>
            ))}
          </ListEditor>
        </>
      );
    }

    case "state": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <PlainTextField label="Variable" value={c.variable} onChange={(variable) => set({ variable })} />
          <SelectField
            label="Operation"
            value={c.operation}
            options={["get", "set", "append", "merge"] as const}
            onChange={(operation) => set({ operation })}
          />
        </>
      );
    }

    case "transform":
      return <Note>This node's transform is configured in code (no literal fields yet).</Note>;

    case "subworkflow": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <PlainTextField label="Workflow ID" value={c.workflowId} onChange={(workflowId) => set({ workflowId })} />
          <PlainTextField label="Version" value={c.version ?? ""} onChange={(v) => set({ version: v || undefined })} />
        </>
      );
    }

    case "output": {
      const c = node.config;
      const set = (patch: Partial<typeof c>): void => onChange({ ...node, config: { ...c, ...patch } });
      return (
        <>
          <PlainTextField label="Schema" value={c.schema ?? ""} onChange={(v) => set({ schema: v || undefined })} />
          <Note>Output value binding editing comes in a later slice.</Note>
        </>
      );
    }
  }
}

export function Inspector({ node, onChange, ctx }: InspectorProps): ReactElement {
  const def = NODE_TYPES[node.type];
  return (
    <div className="wf-inspector">
      <div className="wf-inspector-head">
        <div className="wf-inspector-name">{def.name}</div>
        <div className="wf-inspector-type">{def.technical}</div>
      </div>
      <div className="wf-inspector-body">
        <PlainTextField
          label="Name"
          value={node.label ?? ""}
          placeholder={def.name}
          onChange={(v) => onChange({ ...node, label: v || undefined })}
        />
        <NodeForm node={node} onChange={onChange} ctx={ctx} />
      </div>
    </div>
  );
}
