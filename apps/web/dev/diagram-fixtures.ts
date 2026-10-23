import type { HistoryRecord } from "@pi-orb/protocol";

const FLOW = `flowchart LR
    B["Your browser<br/>GlideOS app UI"] -->|"HTTPS request + Access cookie"| A["Cloudflare Access"]
    A -->|"Verified Access JWT"| S["Existing Support API"]
    S --> D["Session / file storage"]

    B -. "Not used for these reads" .-> G["GlideOS app server"]`;

const CONNECT = `sequenceDiagram
    actor U as You
    participant B as Browser
    participant G as GlideOS app
    participant A as Cloudflare Access
    participant I as Staff identity provider
    participant S as Support API

    U->>G: Click “Connect staff access”
    G->>B: Navigate the whole tab to staff-api.glideos.app/connect
    B->>A: Request protected /connect page

    alt No valid Access session
        A->>I: Redirect to staff sign-in
        U->>I: Complete sign-in
        I->>A: Return identity proof
        A->>A: Check staff Access policy
        A->>B: Set protected Access session cookie
    end

    A->>S: Forward /connect with signed Access JWT
    S->>S: Verify JWT
    S->>B: Redirect to the fixed GlideOS app URL
    B->>G: Load app again`;

const EXPIRED = `sequenceDiagram
    participant B as Browser / app UI
    participant A as Cloudflare Access

    B->>A: API request with expired Access cookie
    A-->>B: Reject request or redirect toward sign-in
    B->>B: API read fails, no customer data available
    B->>B: Offer “Reconnect staff access”
    Note over B,A: Reconnect repeats the top-level sign-in flow above`;

const BROKEN = `flowchart LR
    B["Browser"] -->|"HTTPS"| A["Cloudflare Access"]
    A --> S["Support API"
    S --> D["Storage"]`;

const fence = (source: string) => `\`\`\`mermaid\n${source}\n\`\`\``;

export function diagramFixtureRecords(createdAt: string): HistoryRecord[] {
  return [
    {
      id: "diagrams-ask",
      parentId: null,
      timestamp: createdAt,
      type: "message",
      role: "user",
      content: [
        { type: "text", text: "How does the browser read sessions through the staff API?" },
      ],
      overflow: {},
    },
    {
      id: "diagrams-answer",
      parentId: "diagrams-ask",
      timestamp: createdAt,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "## Fetch directly from the browser",
            "Your browser attaches its Access session cookie automatically. The request does **not** pass through the GlideOS app’s server:",
            fence(FLOW),
            "## 1. First-time staff connection",
            "You already have the GlideOS app open. Staff authorization is a separate step.",
            fence(CONNECT),
            "## 2. Expired session",
            fence(EXPIRED),
            "A fence that does not parse keeps its source:",
            fence(BROKEN),
          ].join("\n\n"),
        },
      ],
      overflow: {},
    },
  ];
}
