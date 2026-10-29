import { useRef, useState } from "react";
import { canShareCurrentPage, shareCurrentPage } from "../lib/share-current-page.ts";
import { Icon } from "./Icons.tsx";

export interface ShareNotice {
  message: string;
  error: boolean;
}

export function OrbShareButton({ onNotice }: { onNotice: (notice: ShareNotice | null) => void }) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const label = canShareCurrentPage() ? "Share current page" : "Copy link";
  const share = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    onNotice(null);
    const result = await shareCurrentPage();
    inFlight.current = false;
    setPending(false);
    if (result.isErr()) {
      console.debug("page share failed", { type: result.error.type });
      onNotice({
        message:
          result.error.type === "share_failed"
            ? "Couldn't share this page."
            : "Couldn't copy link.",
        error: true,
      });
    } else if (result.value === "copied") {
      onNotice({ message: "Link copied.", error: false });
    }
  };

  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      disabled={pending}
      onClick={share}
    >
      <Icon name="share" />
    </button>
  );
}
