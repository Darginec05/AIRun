// The palette: a searchable, category-grouped list of node types. Each item
// carries the friendly name + mono technical type, the same identity the canvas
// shows. Items are draggable (the canvas drop handler arrives in a later phase);
// for now this is the browsable catalogue of what the workflow can contain.

import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import type { NodeType } from "@airun/schema";
import { CATEGORIES, NODE_TYPES, PALETTE_GROUPS } from "@airun/node-registry";
import { Icon } from "./icons.js";
import { NODE_DND_MIME } from "./dnd.js";

function matches(type: NodeType, q: string): boolean {
  if (!q) return true;
  const def = NODE_TYPES[type];
  const hay = `${def.name} ${def.technical} ${def.summary}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

export function Palette(): ReactElement {
  const [query, setQuery] = useState("");

  const groups = useMemo(
    () =>
      PALETTE_GROUPS.map((g) => ({ ...g, types: g.types.filter((t) => matches(t, query)) })).filter(
        (g) => g.types.length > 0,
      ),
    [query],
  );

  return (
    <div className="wf-palette">
      <input
        className="wf-palette-search"
        placeholder="Search nodes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="wf-palette-list">
        {groups.map((group) => (
          <section key={group.category} className="wf-palette-group">
            <div className="wf-palette-group-title">{CATEGORIES[group.category].label}</div>
            {group.types.map((type) => {
              const def = NODE_TYPES[type];
              const style = { "--node-hue": `var(${CATEGORIES[def.category].hueVar})` } as CSSProperties;
              return (
                <div
                  key={type}
                  className="wf-palette-item"
                  style={style}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(NODE_DND_MIME, type);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  title={def.summary}
                >
                  <span className="wf-palette-icon">
                    <Icon name={def.icon} />
                  </span>
                  <div className="wf-palette-titles">
                    <div className="wf-palette-name">{def.name}</div>
                    <div className="wf-palette-type">{def.technical}</div>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
        {groups.length === 0 ? <div className="wf-palette-empty">No nodes match “{query}”.</div> : null}
      </div>
    </div>
  );
}
