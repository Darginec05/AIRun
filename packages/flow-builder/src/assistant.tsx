// The AI Assistant tab (right sidebar): a chat where the user describes the agent
// they want and the assistant assembles it on the canvas. This component is purely
// presentational — it renders the conversation, an intro with suggestion chips, a
// typing heartbeat, and a composer, and emits prompts via onSend. The build
// choreography (node creation, staggered entrance) is owned by the canvas, not
// here, so the assistant stays a thin, testable view over a message list.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

export type AssistantMessage =
  | { id: string; role: "user" | "assistant"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "receipt"; title: string; items: ReadonlyArray<string> };

export interface AssistantSuggestion {
  id: string;
  label: string;
}

export interface AssistantProps {
  messages: ReadonlyArray<AssistantMessage>;
  busy: boolean;
  suggestions: ReadonlyArray<AssistantSuggestion>;
  onSend: (text: string) => void;
}

function Avatar({ role }: { role: "user" | "assistant" }): ReactElement {
  return (
    <span className={`wf-assist-avatar is-${role}`} aria-hidden="true">
      {role === "assistant" ? (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
        </svg>
      )}
    </span>
  );
}

function Receipt({ title, items }: { title: string; items: ReadonlyArray<string> }): ReactElement {
  return (
    <div className="wf-assist-receipt">
      <div className="wf-assist-receipt-title">{title}</div>
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            <span className="wf-assist-check" aria-hidden="true">
              ✓
            </span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Assistant({ messages, busy, suggestions, onSend }: AssistantProps): ReactElement {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the latest turn in view as messages stream in or the typing dots appear.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busy]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSend(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter inserts a newline (the usual chat affordance).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="wf-assistant">
      <div className="wf-assist-scroll">
        {empty ? (
          <div className="wf-assist-intro">
            <div className="wf-assist-intro-title">Describe the agent you want</div>
            <p className="wf-assist-intro-sub">
              Tell me what your workflow should do and I&apos;ll assemble it on the canvas — node by node.
            </p>
            <div className="wf-assist-chips">
              {suggestions.map((s) => (
                <button key={s.id} type="button" className="wf-assist-chip" onClick={() => onSend(s.label)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="wf-assist-msgs">
            {messages.map((m) => (
              <div key={m.id} className={`wf-assist-msg is-${m.role}`}>
                <Avatar role={m.role} />
                <div className="wf-assist-bubble">
                  {m.kind === "text" ? m.text : <Receipt title={m.title} items={m.items} />}
                </div>
              </div>
            ))}
            {busy && (
              <div className="wf-assist-msg is-assistant">
                <Avatar role="assistant" />
                <div className="wf-assist-bubble wf-assist-typing" aria-label="Assistant is typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="wf-assist-composer">
        <textarea
          className="wf-assist-input"
          rows={1}
          value={draft}
          placeholder="Describe a workflow to build…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="wf-assist-send"
          onClick={submit}
          disabled={draft.trim() === ""}
          aria-label="Send"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12l16-8-6 16-3-7z" />
            <path d="M11 13l9-9" />
          </svg>
        </button>
      </div>
      <div className="wf-assist-hint">Enter to send · Shift+Enter for a new line</div>
    </div>
  );
}
