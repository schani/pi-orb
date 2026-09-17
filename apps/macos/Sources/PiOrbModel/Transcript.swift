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
  public let timestamp: Date?
  public let kind: Kind

  init(id: String, timestamp: Date? = nil, kind: Kind) {
    self.id = id
    self.timestamp = timestamp
    self.kind = kind
  }

  public enum Kind: Sendable, Equatable {
    case userText(String)
    case assistantText([MarkdownBlock])
    case tools(ToolGroup)
    case shell(command: String, output: String)
    case note(String)
    case failure(String)
    case pending(String)
    case live([MarkdownBlock])
  }
}

/// Projects reducer state plus not-yet-represented inbox messages into rows.
///
/// Adjacent tool calls inside an agent turn form one maximal run and collapse
/// into one row per category; rendered prose, a shell block, a note, a failure
/// or a user turn cuts the run. Reasoning does not: this client drops it, and a
/// cut with nothing between the two halves would be an invisible reason.
public func present(_ state: TranscriptReducer.State, pending: [PendingMessage]) -> [TranscriptRow]
{
  var results: [TranscriptRow] = []
  var represented: Set<String> = []
  var committed: Set<String> = []
  var resultOf: [String: (isError: Bool, output: String, patch: String?)] = [:]

  for record in state.records {
    guard case .message(let message) = record.body else { continue }
    represented.formUnion(message.inboxMessageIds)
    for block in message.content {
      switch block {
      case .toolCall(let callId, _, _):
        committed.insert(callId)
      case .toolResult(let callId, let isError, let output, let patch):
        resultOf[callId] = (isError, output, patch)
      default:
        break
      }
    }
  }

  var run: [ToolCall] = []
  var runId = ""
  var runAt: Date?
  func flush() {
    guard !run.isEmpty else { return }
    results += toolGroups(runId: runId, calls: run).map {
      TranscriptRow(id: $0.id, timestamp: runAt, kind: .tools($0))
    }
    run = []
  }

  for record in state.records {
    switch record.body {
    case .message(let message):
      for (offset, block) in message.content.enumerated() {
        let id = "\(record.id)#\(offset)"
        switch block {
        case .text(let text) where !text.isEmpty:
          flush()
          results.append(
            TranscriptRow(
              id: id, timestamp: record.timestamp,
              kind: message.role == .user
                ? .userText(text) : .assistantText(parseMarkdown(text))))
        case .toolCall(let callId, let name, let arguments):
          if run.isEmpty {
            runId = id
            runAt = record.timestamp
          }
          let result = resultOf[callId]
          run.append(
            ToolCall(
              callId: callId, name: name, arguments: arguments,
              output: result?.output ?? "", patch: result?.patch,
              status: result.map { $0.isError ? .failed : .completed } ?? .running))
        default:
          break
        }
      }
      if let failure = message.failure {
        flush()
        results.append(
          TranscriptRow(
            id: "\(record.id)#failure", timestamp: record.timestamp, kind: .failure(failure)))
      }
    case .event(let event):
      if let shell = event.shell {
        flush()
        results.append(
          TranscriptRow(
            id: record.id, timestamp: record.timestamp,
            kind: .shell(command: shell.command, output: shell.output)))
      } else if event.custom?.display == true {
        let text = event.content.compactMap(textOf).joined(separator: "\n")
        if !text.isEmpty {
          flush()
          results.append(
            TranscriptRow(id: record.id, timestamp: record.timestamp, kind: .note(text)))
        }
      }
    case .compaction, .other:
      break
    }
  }
  flush()

  for message in pending where !represented.contains(message.id) {
    results.append(TranscriptRow(id: message.id, kind: .pending(message.text)))
  }

  let live = state.liveTools.filter { !committed.contains($0.callId) }.map {
    ToolCall(callId: $0.callId, name: $0.name, status: $0.status)
  }
  results += toolGroups(runId: "live", calls: live).map {
    TranscriptRow(id: $0.id, kind: .tools($0))
  }

  for block in state.liveBlocks where block.blockType != .reasoning && !block.text.isEmpty {
    results.append(TranscriptRow(id: block.blockId, kind: .live(parseMarkdown(block.text))))
  }

  return results
}

private func textOf(_ block: ContentBlock) -> String? {
  if case .text(let text) = block { return text }
  return nil
}
