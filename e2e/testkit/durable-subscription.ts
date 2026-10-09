export function readonlySubscription(
  frames: readonly { direction: string; payload: string; socketGeneration: number }[],
  generation: number,
): number | null {
  const settings = frames.findLast(
    (frame) =>
      frame.socketGeneration === generation &&
      frame.direction === "received" &&
      frame.payload.includes('"type":"agent_settings"'),
  );
  const welcomed = frames.some(
    (frame) =>
      frame.socketGeneration === generation &&
      frame.direction === "received" &&
      frame.payload.includes('"type":"server.welcome"'),
  );
  return welcomed && settings?.payload.includes('"writable":false') ? generation : null;
}
