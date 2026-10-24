import { createContext } from "react";
import type { DashboardCache } from "./dashboard-cache.ts";

export const DashboardCacheContext = createContext<DashboardCache | null>(null);
