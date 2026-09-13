import { useEffect, useState } from "react";

/** Keep this breakpoint synchronized with the phone-only stylesheet. */
export const PHONE_QUERY = "(max-width: 600px)";

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}
