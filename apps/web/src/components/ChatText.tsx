import Linkify from "linkify-react";
import type { Opts } from "linkifyjs";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

function isWebUrl(value: string): boolean {
  if (/^www\./i.test(value)) return true;
  return /^https?:\/\//i.test(value);
}

/**
 * Plain chat text stays literal (it is not Markdown), but web URL tokens become
 * links. Linkify's parser handles punctuation and URL boundaries rather than a
 * local regular expression; the validation gate excludes email and non-web
 * schemes.
 */
const plainTextLinkOptions: Opts = {
  defaultProtocol: "https",
  target: "_blank",
  rel: "noopener noreferrer",
  validate: {
    url: isWebUrl,
    email: false,
  },
};

export function PlainChatText({ children }: { children: string }) {
  return <Linkify options={plainTextLinkOptions}>{children}</Linkify>;
}

/** Shared anchor policy for links produced from assistant Markdown. */
type ChatLinkProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

export function ChatLink({ href, node: _node, ...props }: ChatLinkProps): ReactNode {
  const isExternalWebUrl = href !== undefined && /^(?:https?:)?\/\//i.test(href);
  return (
    <a
      {...props}
      href={href}
      target={isExternalWebUrl ? "_blank" : undefined}
      rel={isExternalWebUrl ? "noopener noreferrer" : undefined}
    />
  );
}
