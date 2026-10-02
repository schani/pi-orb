export function exactReviewedCall(server, tool, input, reviewed) {
  if (!Object.hasOwn(reviewed, server) || !Object.hasOwn(reviewed[server], tool)) return false;
  const approved = reviewed[server][tool];
  if (!approved || !input || typeof input !== "object" || Array.isArray(input)) return false;
  return (Array.isArray(approved) ? approved : [approved]).some(
    (expected) =>
      Object.keys(input).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([key, value]) =>
          Object.hasOwn(input, key) && JSON.stringify(input[key]) === JSON.stringify(value),
      ),
  );
}

export function summarizeCloudflareRead(result) {
  if (result.isError || !Array.isArray(result.content)) return { apiSuccess: "unverified" };
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try {
      const parsed = JSON.parse(item.text);
      if (
        typeof parsed.success === "boolean" &&
        Number.isInteger(parsed.status) &&
        parsed.status >= 100 &&
        parsed.status <= 599 &&
        Number.isInteger(parsed.count) &&
        parsed.count >= 0 &&
        parsed.count <= 1
      )
        return { apiSuccess: parsed.success, apiStatus: parsed.status, count: parsed.count };
    } catch {
      /* Untrusted response may not be JSON. */
    }
  }
  return { apiSuccess: "unverified" };
}

export function summarizeApplicationRead(result) {
  const summary = { outcome: result.isError ? "error" : "unknown", truncated: false, keys: [] };
  const texts = Array.isArray(result.content)
    ? result.content.filter((item) => item.type === "text" && typeof item.text === "string")
    : [];
  for (const item of texts.slice(0, 3)) {
    if (/^Warning: truncated output\b/i.test(item.text)) summary.truncated = true;
    const yamlCount = item.text.match(/^count: ([0-9]+)$/m);
    const yamlResults = item.text.match(/^results\[([0-9]+)\]:$/m);
    if (yamlCount && yamlResults) {
      const count = Number(yamlCount[1]);
      const size = Number(yamlResults[1]);
      summary.keys = ["count", "results"];
      if (Number.isSafeInteger(count) && Number.isSafeInteger(size)) {
        summary.totalCount = count;
        summary.resultCount = size;
      }
      if (/^\s*(?:- )?(?:error|errors):/m.test(item.text)) summary.outcome = "error";
      else if (
        !result.isError &&
        size === 1 &&
        count >= size &&
        /^\s*- id: .+$/m.test(item.text) &&
        /^\s+name: .+$/m.test(item.text)
      ) {
        summary.outcome = "success";
      }
      break;
    }
    const fenced = item.text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const embedded = item.text.match(/^Result:\s*([\s\S]+)$/i);
    let parsed;
    try {
      parsed = JSON.parse(fenced ? fenced[1] : embedded ? embedded[1] : item.text);
    } catch {
      const status = item.text.match(/^status:\s*(success|ok|error)\s*$/im)?.[1]?.toLowerCase();
      if (status) {
        summary.outcome = result.isError || status === "error" ? "error" : "success";
        summary.keys = [
          "status",
          ...["results", "monitors", "dashboards"].filter((key) =>
            new RegExp(`^${key}:\\s*\\d+\\s*$`, "im").test(item.text),
          ),
        ];
        break;
      }
      continue;
    }
    if (Array.isArray(parsed)) continue;
    if (typeof parsed !== "object" || parsed === null) continue;
    const keys = [
      "status",
      "success",
      "results",
      "data",
      "error",
      "errors",
      "count",
      "total",
      "monitors",
      "dashboards",
    ];
    summary.keys = keys.filter((key) => Object.hasOwn(parsed, key));
    if (
      result.isError ||
      parsed.success === false ||
      parsed.status === "error" ||
      (parsed.error != null && parsed.error !== false) ||
      (Array.isArray(parsed.errors) && parsed.errors.length > 0)
    )
      summary.outcome = "error";
    else if (parsed.success === true || parsed.status === "success" || parsed.status === "ok")
      summary.outcome = "success";
    else if (
      ["results", "monitors", "dashboards"].some(
        (key) =>
          Array.isArray(parsed[key]) &&
          parsed[key].every(
            (value) =>
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              value.error == null &&
              value.errors == null,
          ),
      )
    )
      summary.outcome = "success";
    for (const key of ["results", "data", "monitors", "dashboards"])
      if (Array.isArray(parsed[key])) {
        summary.resultCount = parsed[key].length;
        break;
      }
    break;
  }
  if (result.isError) summary.outcome = "error";
  return summary;
}

// Render only structural tokens: no provider-supplied scalar survives, including record fields and bearers.
export function redactResponseExcerpt(result) {
  const text = Array.isArray(result.content)
    ? result.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .slice(0, 2)
        .map((item) => item.text.slice(0, 1000))
        .join("\n")
    : "";
  const labels = new Set([
    "Result",
    "Output",
    "Error",
    "status",
    "success",
    "results",
    "data",
    "error",
    "errors",
    "count",
    "total",
    "monitors",
    "dashboards",
    "id",
    "name",
    "type",
    "message",
    "description",
    "query",
    "url",
    "Authorization",
    "Bearer",
    "max_tokens",
    "code",
    "result",
    "response",
    "Token",
    "budget",
    "too",
    "low",
    "Set",
    "at",
    "least",
    "required",
    "must",
    "provide",
    "no",
    "found",
    "invalid",
    "search",
  ]);
  const publicWords = new Set([
    "Token",
    "budget",
    "too",
    "low",
    "Set",
    "at",
    "least",
    "required",
    "must",
    "provide",
    "no",
    "found",
    "invalid",
    "search",
    "max_tokens",
  ]);
  return text
    .slice(0, 1000)
    .replace(/[A-Za-z_][A-Za-z_0-9-]*|[0-9]+/g, (word, position, source) => {
      if (
        labels.has(word) &&
        (/^\s*[":]/.test(source.slice(position + word.length)) ||
          /^\[\d+\]:/.test(source.slice(position + word.length)) ||
          /^\s*>/.test(source.slice(position + word.length)) ||
          publicWords.has(word))
      )
        return word;
      return "x";
    });
}

export function summarizeDatadogRead(result) {
  const summary = { outcome: result.isError ? "error" : "unknown" };
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text
    : undefined;
  if (!text) return summary;
  const truncated = text.match(/<is_truncated>(true|false)<\/is_truncated>/)?.[1];
  const count = text.match(/<displayed_items>([0-9]+)<\/displayed_items>/)?.[1];
  if (count && Number.isSafeInteger(Number(count))) summary.displayedItems = Number(count);
  if (result.isError) return summary;
  if (!truncated && !count && /<JSON_DATA>\s*<\/JSON_DATA>/.test(text)) {
    const message = text.match(/<message>([^<]{0,500})<\/message>/)?.[1];
    if (
      /^\s*No monitors (?:found|match(?:ing)?)/i.test(message ?? "") ||
      /^\s*No (?:monitors?|results?|items?|data) (?:were )?returned\b/i.test(message ?? "") ||
      (/^\s*No [a-z ]{1,40} returned\b/i.test(message ?? "") &&
        /\bquery is too\b/i.test(message ?? ""))
    )
      return { outcome: "success", resultCount: 0 };
    const vocabulary = new Set([
      "no",
      "monitors",
      "monitor",
      "found",
      "matching",
      "match",
      "query",
      "search",
      "results",
      "result",
      "returned",
      "try",
      "a",
      "different",
      "broader",
      "filter",
      "is",
      "too",
      "strict",
      "please",
      "permission",
      "denied",
      "error",
      "failed",
      "could",
      "not",
      "be",
      "retrieved",
      "for",
      "this",
      "account",
      "in",
      "datadog",
      "any",
      "were",
      "to",
      "and",
      "status",
      "priority",
      "invalid",
      "the",
      "your",
      "request",
      "unexpected",
      "occurred",
      "again",
      "there",
      "are",
    ]);
    if (message)
      summary.messageTerms =
        message
          .match(/[a-z]+/gi)
          ?.filter((word) => vocabulary.has(word.toLowerCase()))
          .slice(0, 30) ?? [];
  }
  if (truncated === "true") {
    summary.outcome = "truncated";
    summary.maxTokensHint = /<truncation_message>[^<]*max_tokens[^<]*<\/truncation_message>/i.test(
      text,
    );
    return summary;
  }
  if (truncated !== "false" || summary.displayedItems === undefined) return summary;
  const data = text.match(/<JSON_DATA>\s*([\s\S]*?)\s*<\/JSON_DATA>/)?.[1];
  if (!data) return summary;
  try {
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed.error != null || parsed.errors != null)
    )
      summary.outcome = "error";
    else if (
      Array.isArray(parsed) &&
      parsed.length === summary.displayedItems &&
      parsed.every(
        (item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          item.error == null &&
          item.errors == null,
      )
    ) {
      summary.outcome = "success";
      summary.resultCount = parsed.length;
    }
  } catch {
    /* Untrusted application text is not guaranteed JSON. */
  }
  return summary;
}

export function summarizeGrant(server, grant) {
  return { server, generation: grant.generation, expiresAt: grant.expiresAt };
}

export function summarizeReadShape(result) {
  const texts = Array.isArray(result.content)
    ? result.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .slice(0, 3)
    : [];
  const allowed = [
    "status",
    "success",
    "results",
    "data",
    "error",
    "errors",
    "count",
    "total",
    "monitors",
    "dashboards",
    "id",
    "name",
    "type",
    "message",
  ];
  const knownKeys = allowed.filter((key) =>
    texts.some((item) => new RegExp(`(?:^|[\\{,])\\s*["']?${key}["']?\\s*:`, "im").test(item.text)),
  );
  const markers = texts.flatMap(({ text }) => {
    const prefix = text.trimStart();
    if (/^Output\s*:/i.test(prefix)) return ["output"];
    if (/^Result\s*:/i.test(prefix)) return ["result"];
    if (/^Error\s*:/i.test(prefix)) return ["error"];
    return [];
  });
  const jsonCandidate = texts.some(({ text }) => /\{[\s\S]*\}/.test(text))
    ? "object"
    : texts.some(({ text }) => /\[[\s\S]*\]/.test(text))
      ? "array"
      : undefined;
  const xmlTags = [
    ...new Set(
      texts.flatMap(({ text }) =>
        [...text.slice(0, 1000).matchAll(/<\/?([A-Za-z][A-Za-z0-9_-]{0,48})>/g)].map(
          (match) => match[1],
        ),
      ),
    ),
  ].slice(0, 8);
  return {
    ...(xmlTags.length ? { xmlTags } : {}),
    formats: texts.map(({ text }) => {
      const prefix = text.trimStart();
      if (/^```(?:json)?\s*\[/i.test(prefix)) return "fenced_json_array";
      if (/^```(?:json)?\s*\{/i.test(prefix)) return "fenced_json_object";
      if (prefix.startsWith("[")) return "json_array";
      if (prefix.startsWith("{")) return "json_object";
      if (prefix.startsWith("#")) return "markdown";
      return "plain";
    }),
    knownKeys,
    textCount: texts.length,
    ...(markers.length ? { markers } : {}),
    ...(jsonCandidate &&
    texts.some(({ text }) => /^(?:Output|Result|Error)\s*:/i.test(text.trimStart()))
      ? { jsonCandidate }
      : {}),
  };
}

export function summarizeCall(server, tool, result, durationMs) {
  return {
    server,
    tool,
    status: result.isError ? "error" : "ok",
    contentCount: Array.isArray(result.content) ? result.content.length : 0,
    durationMs,
  };
}
