import type { ComponentPropsWithoutRef } from "react";

export function TextFieldFrame({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span className={className ? `text-field-frame ${className}` : "text-field-frame"} {...props} />
  );
}
