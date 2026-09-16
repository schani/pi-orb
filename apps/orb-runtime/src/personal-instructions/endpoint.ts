import type { BrokerEnv } from "../broker/endpoint.ts";
import { fetchInstructions } from "../instructions/endpoint.ts";

export const fetchPersonalInstructions = (env: BrokerEnv, fetcher: typeof fetch = fetch) =>
  fetchInstructions(env, "personal", fetcher);
