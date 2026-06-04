// Syntax highlighting for the code drawer, via Shiki's fine-grained core: the
// JavaScript regex engine (no WASM) plus only the grammars we render (TypeScript
// + JSON) and one dark theme. Shiki and its grammars are heavy, so the whole graph
// is dynamically imported on first use — it splits into its own chunk that loads
// only when the drawer is first opened, keeping the initial bundle lean. The
// highlighter is built once and shared; output is themed HTML (Shiki escapes the
// source) injected into the drawer.

import type { HighlighterCore } from "shiki/core";

export type CodeLang = "typescript" | "json";

const THEME = "tokyo-night";

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighter) {
    highlighter = (async (): Promise<HighlighterCore> => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, tokyoNight, typescript, json] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("@shikijs/themes/tokyo-night"),
          import("@shikijs/langs/typescript"),
          import("@shikijs/langs/json"),
        ]);
      return createHighlighterCore({
        themes: [tokyoNight.default],
        langs: [typescript.default, json.default],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      });
    })();
  }
  return highlighter;
}

export async function highlightCode(code: string, lang: CodeLang): Promise<string> {
  const hl = await getHighlighter();
  return hl.codeToHtml(code, { lang, theme: THEME });
}
