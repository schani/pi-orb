import mermaid from "mermaid";
import { ResultAsync } from "neverthrow";

/** Browser-only adapter around Mermaid; loaded lazily so Mermaid stays out of the main bundle. */

export type MermaidRenderError =
  | { readonly type: "mermaid_parse_failed"; readonly line: number | null }
  | { readonly type: "mermaid_render_failed"; readonly message: string };

const MONO = '"JetBrains Mono", monospace';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  look: "classic",
  layout: "dagre",
  fontFamily: MONO,
  fontSize: 12,
  themeVariables: {
    fontFamily: MONO,
    fontSize: "12px",
    background: "#fff",
    primaryColor: "#fff",
    primaryTextColor: "#000",
    primaryBorderColor: "#000",
    secondaryColor: "#f2f2f2",
    tertiaryColor: "#fff",
    lineColor: "#000",
    textColor: "#000",
    mainBkg: "#fff",
    nodeBorder: "#000",
    clusterBkg: "#f2f2f2",
    clusterBorder: "#999",
    edgeLabelBackground: "#fff",
    actorBkg: "#fff",
    actorBorder: "#000",
    actorTextColor: "#000",
    actorLineColor: "#999",
    signalColor: "#000",
    signalTextColor: "#000",
    labelBoxBkgColor: "#000",
    labelBoxBorderColor: "#000",
    labelTextColor: "#fff",
    loopTextColor: "#000",
    noteBkgColor: "#f2f2f2",
    noteBorderColor: "#999",
    noteTextColor: "#000",
    activationBkgColor: "#f2f2f2",
    activationBorderColor: "#000",
  },
  themeCSS: `
    rect, .node rect, .actor, .note, .labelBox { rx: 0 !important; ry: 0 !important; }
    .actor { stroke-width: 1px; }
    .actor-you { fill: #000; stroke: #000; }
    text.actor-you-text, text.actor-you-text > tspan { fill: #fff !important; }
    .actor-line { stroke: #999; stroke-dasharray: 2 3; }
    .loopLine { stroke: #000; stroke-width: 1px; stroke-dasharray: 3 3; }
    .loopText, .loopText > tspan { fill: #000; font-weight: 700; }
    .labelText, .labelText > tspan { fill: #fff; font-weight: 700; letter-spacing: .08em; }
    .edgeLabel, .edgeLabel p { background: #fff; color: #555; }
    .flowchart-link { stroke-width: 1px; }
    marker path { fill: #000; stroke: #000; }
  `,
  flowchart: {
    useMaxWidth: false,
    curve: "basis",
    padding: 10,
    nodeSpacing: 36,
    rankSpacing: 56,
    wrappingWidth: 200,
    minNodeWidth: 0,
  },
  sequence: {
    useMaxWidth: false,
    mirrorActors: false,
    width: 96,
    height: 44,
    actorMargin: 36,
    boxMargin: 8,
    noteMargin: 8,
    messageMargin: 24,
    diagramMarginX: 4,
    diagramMarginY: 4,
  },
});

let sequence = 0;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Sequence actors become inverted boxes instead of stick figures, echoing the black "you" band. */
function boxActors(svg: SVGSVGElement) {
  for (const actor of svg.querySelectorAll<SVGGElement>("g.actor-man")) {
    const text = actor.querySelector("text");
    if (text === null) continue;
    const x = Number(text.getAttribute("x"));
    const width = Number(actor.querySelector("circle")?.getAttribute("width") ?? 96);
    for (const part of actor.querySelectorAll("line, circle")) part.remove();
    const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [name, value] of Object.entries({
      x: x - width / 2,
      y: 0,
      width,
      height: 44,
      class: "actor-you",
    }))
      box.setAttribute(name, String(value));
    actor.prepend(box);
    text.setAttribute("y", "22");
    text.classList.add("actor-you-text");
    svg.querySelector(`.actor-line[data-id="${actor.dataset["id"]}"]`)?.setAttribute("y1", "44");
  }
}

/** Renders to SVG markup sized by `--mermaid-width`, its natural width. */
export function renderMermaid(source: string): ResultAsync<string, MermaidRenderError> {
  const id = `pi-mermaid-${++sequence}`;
  return ResultAsync.fromPromise(mermaid.parse(source), (cause): MermaidRenderError => {
    const line = /line (\d+)/.exec(message(cause))?.[1];
    return { type: "mermaid_parse_failed", line: line === undefined ? null : Number(line) };
  })
    .andThen(() =>
      // Mermaid measures label text; measuring a fallback face misplaces every box.
      ResultAsync.fromPromise(
        document.fonts.load(`12px ${MONO}`).then(async () => {
          const container = document.createElement("div");
          container.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none";
          document.body.append(container);
          try {
            return await mermaid.render(id, source, container);
          } finally {
            container.remove();
          }
        }),
        (cause): MermaidRenderError => ({ type: "mermaid_render_failed", message: message(cause) }),
      ),
    )
    .map(({ svg: markup }) => {
      const template = document.createElement("template");
      template.innerHTML = markup.trim();
      const svg = template.content.querySelector("svg");
      if (svg === null) return markup;
      boxActors(svg);
      const { width, height } = svg.viewBox.baseVal;
      svg.setAttribute("width", String(Math.ceil(width)));
      svg.setAttribute("height", String(Math.ceil(height)));
      svg.setAttribute("style", `--mermaid-width: ${Math.ceil(width)}px`);
      return svg.outerHTML;
    });
}
