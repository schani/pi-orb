import Foundation

/// Normalized history records (`packages/protocol/src/history.ts`). Only the
/// fields this client renders are decoded; `overflow` is never read.
public enum MessageRole: Sendable, Equatable {
  case user
  case assistant
  case other

  init(raw: String) {
    switch raw {
    case "user": self = .user
    case "assistant": self = .assistant
    default: self = .other
    }
  }
}

public enum ContentBlock: Sendable, Equatable {
  case text(String)
  case reasoning(String)
  case toolCall(callId: String, name: String, arguments: JSONValue?)
  case toolResult(callId: String, isError: Bool, output: String, patch: String?)
  case other
}

extension ContentBlock: Decodable {
  private enum Key: String, CodingKey {
    case type, text, callId, name, arguments, isError, content, patch
  }

  /// `tool_result` nests one level of blocks; only their text is rendered.
  private struct Nested: Decodable {
    let type: String?
    let text: String?
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    switch try container.decodeIfPresent(String.self, forKey: .type) ?? "" {
    case "text":
      self = .text(try container.decodeIfPresent(String.self, forKey: .text) ?? "")
    case "reasoning":
      self = .reasoning(try container.decodeIfPresent(String.self, forKey: .text) ?? "")
    case "tool_call":
      self = .toolCall(
        callId: try container.decode(String.self, forKey: .callId),
        name: try container.decode(String.self, forKey: .name),
        arguments: try container.decodeIfPresent(JSONValue.self, forKey: .arguments))
    case "tool_result":
      let nested = try container.decodeIfPresent([Nested].self, forKey: .content) ?? []
      self = .toolResult(
        callId: try container.decode(String.self, forKey: .callId),
        isError: try container.decodeIfPresent(Bool.self, forKey: .isError) ?? false,
        output: nested.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n"),
        patch: try container.decodeIfPresent(String.self, forKey: .patch))
    default:
      self = .other
    }
  }
}

public struct ShellExecution: Decodable, Sendable, Equatable {
  public let command: String
  public let output: String
}

public struct CustomMessage: Decodable, Sendable, Equatable {
  public let customType: String
  public let display: Bool
}

public struct HistoryRecord: Sendable, Equatable {
  public let id: String
  public let timestamp: Date?
  public let body: Body

  public enum Body: Sendable, Equatable {
    case message(Message)
    case compaction
    case event(Event)
    case other
  }

  public struct Message: Sendable, Equatable {
    public let role: MessageRole
    public let content: [ContentBlock]
    public let inboxMessageIds: [String]
    public let failure: String?
  }

  public struct Event: Sendable, Equatable {
    public let eventType: String
    public let content: [ContentBlock]
    public let shell: ShellExecution?
    public let custom: CustomMessage?
  }
}

extension HistoryRecord: Decodable {
  private enum Key: String, CodingKey {
    case id, timestamp, type, role, content, inboxMessageIds, failure, eventType, shell, custom
  }

  private struct Failure: Decodable {
    let message: String
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    id = try container.decode(String.self, forKey: .id)
    timestamp = try container.decodeIfPresent(String.self, forKey: .timestamp)
      .flatMap(isoTimestamp(_:))
    let content = try container.decodeIfPresent([ContentBlock].self, forKey: .content) ?? []
    switch try container.decodeIfPresent(String.self, forKey: .type) ?? "" {
    case "message":
      let raw = try container.decodeIfPresent(String.self, forKey: .role)
      body = .message(
        Message(
          role: raw.map(MessageRole.init(raw:)) ?? .other,
          content: content,
          inboxMessageIds: try container.decodeIfPresent(
            [String].self, forKey: .inboxMessageIds) ?? [],
          failure: try container.decodeIfPresent(Failure.self, forKey: .failure)?.message))
    case "compaction":
      body = .compaction
    case "event":
      body = .event(
        Event(
          eventType: try container.decode(String.self, forKey: .eventType),
          content: content,
          shell: try container.decodeIfPresent(ShellExecution.self, forKey: .shell),
          custom: try container.decodeIfPresent(CustomMessage.self, forKey: .custom)))
    default:
      body = .other
    }
  }
}

/// Record timestamps are ISO-8601 with fractional seconds; an unparsable one is
/// simply absent rather than fatal.
private func isoTimestamp(_ raw: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
}
