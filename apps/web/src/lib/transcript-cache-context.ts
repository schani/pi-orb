import { createContext } from "react";
import type { TranscriptCache } from "./transcript-cache.ts";

/** Optional for isolated reusable mutation controls; the application always supplies it. */
export const TranscriptCacheContext = createContext<TranscriptCache | null>(null);
