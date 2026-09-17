import Foundation

/// A message enqueued through the durable inbox and not yet represented by a
/// history record.
public struct PendingMessage: Sendable, Equatable, Identifiable {
  public let id: String
  public let text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

public struct TranscriptRow: Sendable, Equatable, Identifiable {
  public let id: String
  public let kind: Kind

  public enum Kind: Sendable, Equatable {
    case userText(String)
    case assistantText(String)
    case tool(name: String, status: ToolStatus)
    case shell(command: String, output: String)
    case note(String)
    case failure(String)
    case pending(String)
    case live(String)
  }
}

/// Projects reducer state plus not-yet-represented inbox messages into rows.
public func present(_ state: TranscriptReducer.State, pending: [PendingMessage]) -> [TranscriptRow]
{
  var results: [TranscriptRow] = []
  var toolStatus: [String: ToolStatus] = [:]
  var represented: Set<String> = []

  for record in state.records {
    guard case .message(let message) = record.body else { continue }
    represented.formUnion(message.inboxMessageIds)
    for block in message.content {
      if case .toolResult(let callId, let isError) = block {
        toolStatus[callId] = isError ? .failed : .completed
      }
    }
  }

  for record in state.records {
    switch record.body {
    case .message(let message):
      for (offset, block) in message.content.enumerated() {
        let id = "\(record.id)#\(offset)"
        switch block {
        case .text(let text) where !text.isEmpty:
          results.append(
            TranscriptRow(
              id: id,
              kind: message.role == .user
                ? .userText(text) : .assistantText(text)))
        case .toolCall(let callId, let name):
          results.append(
            TranscriptRow(
              id: id,
              kind: .tool(name: name, status: toolStatus[callId] ?? .running)))
        default:
          break
        }
      }
      if let failure = message.failure {
        results.append(
          TranscriptRow(id: "\(record.id)#failure", kind: .failure(failure)))
      }
    case .event(let event):
      if let shell = event.shell {
        results.append(
          TranscriptRow(
            id: record.id,
            kind: .shell(command: shell.command, output: shell.output)))
      } else if event.custom?.display == true {
        let text = event.content.compactMap(textOf).joined(separator: "\n")
        if !text.isEmpty {
          results.append(TranscriptRow(id: record.id, kind: .note(text)))
        }
      }
    case .compaction, .other:
      break
    }
  }

  for message in pending where !represented.contains(message.id) {
    results.append(TranscriptRow(id: message.id, kind: .pending(message.text)))
  }

  for block in state.liveBlocks where block.blockType != .reasoning && !block.text.isEmpty {
    results.append(TranscriptRow(id: block.blockId, kind: .live(block.text)))
  }

  for tool in state.liveTools {
    results.append(
      TranscriptRow(id: tool.callId, kind: .tool(name: tool.name, status: tool.status)))
  }

  return results
}

private func textOf(_ block: ContentBlock) -> String? {
  if case .text(let text) = block { return text }
  return nil
}
