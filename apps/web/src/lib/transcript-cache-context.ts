import type { TranscriptCache } from "@pi-orb/transcript";
import { createContext } from "react";

/** Optional for isolated reusable mutation controls; the application always supplies it. */
export const TranscriptCacheContext = createContext<TranscriptCache | null>(null);
