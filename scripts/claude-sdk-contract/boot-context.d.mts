export function probePassiveBootContext(marker: string): Promise<{
  passiveRequests: number;
  metadataRequests: number;
  humanRequests: number;
  passiveBootEntries: { isMeta: boolean; version: string }[];
  passiveAssistantEntries: unknown[];
  afterHumanBootEntries: unknown[];
  humanMessages: unknown;
  fifoRequests: number;
  fifoMessages: unknown;
  fifoResults: {
    subtype: string;
    num_turns: number;
    user_message_uuids: string[];
    queued_turn_count: number;
  }[];
  fifoBootUuid: string;
  humanUuid: string;
  cliVersion: string;
}>;
