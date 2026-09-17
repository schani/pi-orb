import Foundation

/// Live WebSocket subprotocol (`packages/protocol/src/frames.ts`).
public let runtimeSubprotocol = "pi-orb.runtime.v1"

public enum Activity: String, Decodable, Sendable, Equatable {
  case idle
  case busy
}

public enum SyncMode: Sendable, Equatable {
  case full
  case after
}

public enum LiveBlockType: Sendable, Equatable {
  case text
  case reasoning
  case shell
  case other
}

public enum ToolStatus: Sendable, Equatable {
  case running
  case completed
  case failed
}

public struct OutputPatch: Sendable, Equatable {
  public let blockId: String
  public let blockType: LiveBlockType
  public let append: Bool
  public let text: String
}

public struct ToolStateChange: Sendable, Equatable {
  public let callId: String
  public let name: String
  public let status: ToolStatus
}

/// A well-formed frame carrying an unrecognized event type decodes to
/// `.unknown` rather than failing: v1 clients ignore unknown server events
/// (`docs/runtime-protocol.md`).
public enum RuntimeEvent: Sendable, Equatable {
  case status(activity: Activity, operationId: String?)
  case operationStarted(operationId: String)
  case outputPatch(OutputPatch)
  case toolState(ToolStateChange)
  case operationFinished(operationId: String, failure: String?)
  case unknown
}

extension RuntimeEvent: Decodable {
  private enum Key: String, CodingKey {
    case type, activity, operationId, blockId, blockType, patch, callId, name, state,
      message, outcome
  }

  private struct Patch: Decodable {
    let type: String
    let text: String
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    let operationId = try container.decodeIfPresent(String.self, forKey: .operationId)
    switch try container.decodeIfPresent(String.self, forKey: .type) ?? "" {
    case "status":
      guard
        let activity = Activity(
          rawValue: try container.decode(String.self, forKey: .activity))
      else {
        self = .unknown
        return
      }
      self = .status(activity: activity, operationId: operationId)
    case "operation_started":
      self = .operationStarted(operationId: try container.decode(String.self, forKey: .operationId))
    case "output_patch":
      let patch = try container.decode(Patch.self, forKey: .patch)
      let blockType =
        switch try container.decode(String.self, forKey: .blockType) {
        case "text": LiveBlockType.text
        case "reasoning": LiveBlockType.reasoning
        case "shell": LiveBlockType.shell
        default: LiveBlockType.other
        }
      self = .outputPatch(
        OutputPatch(
          blockId: try container.decode(String.self, forKey: .blockId),
          blockType: blockType,
          append: patch.type == "append",
          text: patch.text))
    case "tool_state":
      let status =
        switch try container.decode(String.self, forKey: .state) {
        case "completed": ToolStatus.completed
        case "failed": ToolStatus.failed
        default: ToolStatus.running
        }
      self = .toolState(
        ToolStateChange(
          callId: try container.decode(String.self, forKey: .callId),
          name: try container.decode(String.self, forKey: .name),
          status: status))
    case "operation_finished":
      let failed = try container.decode(String.self, forKey: .outcome) == "failed"
      let message = try container.decodeIfPresent(String.self, forKey: .message)
      self = .operationFinished(
        operationId: try container.decode(String.self, forKey: .operationId),
        failure: failed ? (message ?? "the runtime operation failed") : nil)
    default:
      self = .unknown
    }
  }
}

public struct Welcome: Sendable, Equatable {
  public let sessionId: String
  public let runtimeInstanceId: String
}

public enum ServerFrame: Sendable, Equatable {
  case welcome(Welcome)
  case syncStarted(mode: SyncMode)
  case historyRecord(record: HistoryRecord, retiredBlockIds: [String], headId: String?)
  case syncCompleted(headId: String?)
  case runtimeEvent(RuntimeEvent)
  case requestRejected(message: String)
  case requestAccepted
  case serverError(code: String, message: String)
  case unknown
}

extension ServerFrame: Decodable {
  private enum Key: String, CodingKey {
    case type, sessionId, runtimeInstanceId, mode, record, retiredBlockIds, headId, event,
      result, error
  }

  private struct ErrorBody: Decodable {
    let code: String
    let message: String
  }

  private struct RequestResult: Decodable {
    let type: String
    let error: ErrorBody?
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    switch try container.decodeIfPresent(String.self, forKey: .type) ?? "" {
    case "server.welcome":
      self = .welcome(
        Welcome(
          sessionId: try container.decode(String.self, forKey: .sessionId),
          runtimeInstanceId: try container.decode(
            String.self, forKey: .runtimeInstanceId)))
    case "sync.started":
      self = .syncStarted(
        mode: try container.decode(String.self, forKey: .mode) == "full" ? .full : .after)
    case "history.record":
      self = .historyRecord(
        record: try container.decode(HistoryRecord.self, forKey: .record),
        retiredBlockIds: try container.decodeIfPresent(
          [String].self, forKey: .retiredBlockIds) ?? [],
        headId: try container.decodeIfPresent(String.self, forKey: .headId))
    case "sync.completed":
      self = .syncCompleted(headId: try container.decodeIfPresent(String.self, forKey: .headId))
    case "runtime.event":
      self = .runtimeEvent(try container.decode(RuntimeEvent.self, forKey: .event))
    case "request.result":
      let result = try container.decode(RequestResult.self, forKey: .result)
      self =
        result.type == "rejected"
        ? .requestRejected(message: result.error?.message ?? "request rejected")
        : .requestAccepted
    case "server.error":
      let error = try container.decode(ErrorBody.self, forKey: .error)
      self = .serverError(code: error.code, message: error.message)
    default:
      self = .unknown
    }
  }
}

/// Frames this client sends. It never sends `client.request`: the composer
/// uses the durable HTTP inbox instead.
public enum ClientFrame: Encodable {
  case hello(clientInstanceId: String, afterRecordId: String?)
  case presence(visible: Bool)

  private enum Key: String, CodingKey {
    case v, type, clientInstanceId, afterRecordId, visible
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: Key.self)
    try container.encode(1, forKey: .v)
    switch self {
    case .hello(let clientInstanceId, let afterRecordId):
      try container.encode("client.hello", forKey: .type)
      try container.encode(clientInstanceId, forKey: .clientInstanceId)
      try container.encode(afterRecordId, forKey: .afterRecordId)
    case .presence(let visible):
      try container.encode("client.presence", forKey: .type)
      try container.encode(visible, forKey: .visible)
    }
  }
}
