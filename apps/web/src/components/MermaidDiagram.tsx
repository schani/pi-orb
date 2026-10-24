import { ResultAsync } from "neverthrow";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { MermaidRenderError } from "../lib/mermaid-render.ts";
import { Icon } from "./Icons.tsx";

type Diagram =
  | { readonly type: "pending" }
  | { readonly type: "rendered"; readonly svg: string }
  | { readonly type: "failed"; readonly error: MermaidRenderError };

const loadRenderer = () =>
  ResultAsync.fromPromise(
    import("../lib/mermaid-render.ts"),
    (cause): MermaidRenderError => ({
      type: "mermaid_render_failed",
      message: cause instanceof Error ? cause.message : "Mermaid failed to load",
    }),
  );

function failureText(error: MermaidRenderError): string {
  if (error.type === "mermaid_render_failed") return `Mermaid: ${error.message}`;
  return error.line === null
    ? "Mermaid: parse error"
    : `Mermaid: parse error on line ${error.line}`;
}

/** A closed ```mermaid fence: the diagram on the code block's board, its source one toggle away. */
export function MermaidDiagram({ source, copyButton }: { source: string; copyButton: ReactNode }) {
  const [diagram, setDiagram] = useState<Diagram>({ type: "pending" });
  const [showSource, setShowSource] = useState(false);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const started = performance.now();
    void loadRenderer()
      .andThen((renderer) => renderer.renderMermaid(source))
      .match(
        (svg) => {
          if (!active) return;
          setDiagram({ type: "rendered", svg });
          console.debug("mermaid render", {
            outcome: "rendered",
            ms: Math.round(performance.now() - started),
          });
        },
        (error) => {
          if (!active) return;
          setDiagram({ type: "failed", error });
          console.debug("mermaid render", {
            outcome: error.type === "mermaid_parse_failed" ? "parse_failed" : "render_failed",
            ...error,
          });
        },
      );
    return () => {
      active = false;
    };
  }, [source]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);

  const failed = diagram.type === "failed";
  const sourceVisible = showSource || failed;
  const toggleLabel = showSource ? "Show diagram" : "Show Mermaid source";

  return (
    <div className="mermaid-diagram" data-view={sourceVisible ? "source" : "diagram"}>
      <div className="mermaid-tools">
        {!failed && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-pressed={showSource}
              aria-label={toggleLabel}
              title={toggleLabel}
              onClick={() => setShowSource(!showSource)}
            >
              <Icon name="source" />
            </button>
            <button
              ref={opener}
              type="button"
              className="icon-button"
              aria-label="Open diagram"
              title="Open diagram"
              disabled={diagram.type !== "rendered"}
              onClick={() => setOpen(true)}
            >
              <Icon name="expand" />
            </button>
          </>
        )}
        {copyButton}
      </div>
      {sourceVisible ? (
        <pre>
          <code className="language-mermaid">{source}</code>
        </pre>
      ) : (
        <div
          className="mermaid-canvas"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid's strict security level sanitizes labels; the SVG is its output.
          dangerouslySetInnerHTML={{ __html: diagram.type === "rendered" ? diagram.svg : "" }}
        />
      )}
      {failed && <div className="mermaid-error">{failureText(diagram.error)}</div>}
      {open && diagram.type === "rendered" && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop tap is the touch counterpart of the dialog's native Escape.
        <dialog
          ref={dialog}
          className="mermaid-dialog"
          aria-label="Diagram"
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) dialog.current?.close();
          }}
        >
          <button
            className="tool-image-dialog-close"
            type="button"
            aria-label="Close diagram"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
          <div
            className="mermaid-dialog-canvas"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: same sanitized SVG; a distinct ID prefix keeps marker references off the inline copy.
            dangerouslySetInnerHTML={{
              __html: diagram.svg.replaceAll("pi-mermaid-", "pi-mermaid-open-"),
            }}
          />
        </dialog>
      )}
    </div>
  );
}
