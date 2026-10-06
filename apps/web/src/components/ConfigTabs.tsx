import { type RefObject, useRef } from "react";

export function ConfigTabs({
  id,
  label,
  names,
  selected,
  onSelect,
  disabled = false,
  initialIndex,
  initialRef,
}: {
  id: string;
  label: string;
  names: readonly string[];
  selected: number;
  onSelect(index: number): void;
  disabled?: boolean;
  initialIndex?: number;
  initialRef?: RefObject<HTMLButtonElement | null>;
}) {
  const tabs = useRef<HTMLDivElement>(null);
  return (
    <div ref={tabs} className="project-config-tabs" role="tablist" aria-label={label}>
      {names.map((name, index) => (
        <button
          key={name}
          ref={index === initialIndex ? initialRef : undefined}
          type="button"
          role="tab"
          id={`${id}-tab-${index}`}
          aria-controls={`${id}-panel-${index}`}
          aria-selected={selected === index}
          tabIndex={selected === index ? 0 : -1}
          disabled={disabled}
          onClick={() => onSelect(index)}
          onKeyDown={(event) => {
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? names.length - 1
                  : event.key === "ArrowLeft"
                    ? (index + names.length - 1) % names.length
                    : event.key === "ArrowRight"
                      ? (index + 1) % names.length
                      : null;
            if (next === null) return;
            event.preventDefault();
            onSelect(next);
            tabs.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
          }}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
