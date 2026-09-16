import type { BrokerEnv } from "../broker/endpoint.ts";
import { fetchInstructions } from "../instructions/endpoint.ts";

export const fetchProjectInstructions = (env: BrokerEnv, fetcher: typeof fetch = fetch) =>
  fetchInstructions(env, "project", fetcher);
