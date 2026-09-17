import Foundation
import Testing

@testable import PiOrbModel

private func frame(_ json: String) throws -> ServerFrame {
  try JSONDecoder().decode(ServerFrame.self, from: Data(json.utf8))
}

@Suite("server frame decoding")
struct FrameDecodingTests {
  @Test func welcome() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"server.welcome","at":"2026-09-17T10:00:00.000Z",
       "connectionId":"browser-1","runtimeInstanceId":"rt-1","orbId":"orb-1",
       "sessionId":"sess-1","capabilities":["abort","input.image"],
       "limits":{"maxIncomingFrameBytes":1048576,"maxPromptBytes":262144}}
      """)
    #expect(decoded == .welcome(Welcome(sessionId: "sess-1", runtimeInstanceId: "rt-1")))
  }

  @Test func syncStartedFull() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"sync.started","at":"2026-09-17T10:00:00.000Z","mode":"full",
       "afterRecordId":null}
      """)
    #expect(decoded == .syncStarted(mode: .full))
  }

  @Test func syncStartedAfter() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"sync.started","at":"2026-09-17T10:00:00.000Z","mode":"after",
       "afterRecordId":"rec-3"}
      """)
    #expect(decoded == .syncStarted(mode: .after))
  }

  @Test func historyRecordCarriesRetiredBlocks() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"history.record","at":"2026-09-17T10:00:00.000Z","headId":"rec-9",
       "retiredBlockIds":["block-1"],
       "record":{"id":"rec-9","parentId":"rec-8","timestamp":"2026-09-17T10:00:00.000Z",
        "type":"message","role":"assistant","overflow":{},
        "content":[{"type":"text","text":"done"}]}}
      """)
    guard case .historyRecord(let record, let retired, let headId) = decoded else {
      Issue.record("expected history.record")
      return
    }
    #expect(record.id == "rec-9")
    #expect(retired == ["block-1"])
    #expect(headId == "rec-9")
  }

  @Test func syncCompleted() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"sync.completed","at":"2026-09-17T10:00:00.000Z","headId":"rec-9"}
      """)
    #expect(decoded == .syncCompleted(headId: "rec-9"))
  }

  @Test func requestResultRejected() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"request.result","at":"2026-09-17T10:00:00.000Z","requestId":"req-1",
       "result":{"type":"rejected","error":{"code":"stale_head","message":"head moved",
        "retryable":true}}}
      """)
    #expect(decoded == .requestRejected(message: "head moved"))
  }

  @Test func requestResultAccepted() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"request.result","at":"2026-09-17T10:00:00.000Z","requestId":"req-1",
       "result":{"type":"accepted","operationId":"op-1","duplicate":false}}
      """)
    #expect(decoded == .requestAccepted)
  }

  @Test func serverError() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"server.error","at":"2026-09-17T10:00:00.000Z",
       "error":{"code":"internal","message":"boom","retryable":false}}
      """)
    #expect(decoded == .serverError(code: "internal", message: "boom"))
  }

  @Test func unknownFrameTypeDecodesToUnknown() throws {
    let decoded = try frame(
      """
      {"v":1,"type":"server.telemetry","at":"2026-09-17T10:00:00.000Z","payload":{"a":1}}
      """)
    #expect(decoded == .unknown)
  }
}

@Suite("runtime event decoding")
struct RuntimeEventDecodingTests {
  private func event(_ json: String) throws -> RuntimeEvent {
    let decoded = try frame(
      """
      {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:00.000Z","event":\(json)}
      """)
    guard case .runtimeEvent(let event) = decoded else {
      Issue.record("expected runtime.event")
      return .unknown
    }
    return event
  }

  @Test func status() throws {
    #expect(
      try event(
        """
        {"type":"status","activity":"busy","operationId":"op-1"}
        """) == .status(activity: .busy, operationId: "op-1"))
  }

  @Test func operationStarted() throws {
    #expect(
      try event(
        """
        {"type":"operation_started","operationId":"op-1"}
        """) == .operationStarted(operationId: "op-1"))
  }

  @Test func outputPatchAppend() throws {
    #expect(
      try event(
        """
        {"type":"output_patch","operationId":"op-1","blockId":"block-1","blockType":"text",
         "revision":1,"patch":{"type":"append","text":"hel"}}
        """)
        == .outputPatch(
          OutputPatch(blockId: "block-1", blockType: .text, append: true, text: "hel")))
  }

  @Test func outputPatchReplace() throws {
    #expect(
      try event(
        """
        {"type":"output_patch","operationId":"op-1","blockId":"block-1","blockType":"shell",
         "revision":2,"patch":{"type":"replace","text":"hello"}}
        """)
        == .outputPatch(
          OutputPatch(blockId: "block-1", blockType: .shell, append: false, text: "hello")))
  }

  @Test func toolState() throws {
    #expect(
      try event(
        """
        {"type":"tool_state","operationId":"op-1","callId":"call-1","name":"read_file",
         "revision":1,"state":"completed"}
        """)
        == .toolState(
          ToolStateChange(callId: "call-1", name: "read_file", status: .completed)))
  }

  @Test func operationFinishedCompleted() throws {
    #expect(
      try event(
        """
        {"type":"operation_finished","operationId":"op-1","outcome":"completed"}
        """) == .operationFinished(operationId: "op-1", failure: nil))
  }

  @Test func operationFinishedFailed() throws {
    #expect(
      try event(
        """
        {"type":"operation_finished","operationId":"op-1","outcome":"failed",
         "message":"model error"}
        """) == .operationFinished(operationId: "op-1", failure: "model error"))
  }

  @Test func ignoredEventKindsDecode() throws {
    #expect(
      try event(
        """
        {"type":"subagents","operationId":"op-1",
         "children":[{"id":"c1","description":"tests","phase":"running"}]}
        """) == .unknown)
    #expect(
      try event(
        """
        {"type":"turn_notification","operationId":"op-1","summary":"finished the refactor"}
        """) == .unknown)
    #expect(
      try event(
        """
        {"type":"agent_settings","writable":true,
         "settings":{"model":{"provider":"anthropic","id":"claude"},
          "thinkingLevel":"medium"},"models":[]}
        """) == .unknown)
  }

  @Test func unknownEventTypeDecodesToUnknown() throws {
    #expect(
      try event(
        """
        {"type":"cost_update","operationId":"op-1","costUsd":0.42}
        """) == .unknown)
  }
}

@Suite("history record decoding")
struct HistoryRecordDecodingTests {
  private func record(_ json: String) throws -> HistoryRecord {
    try JSONDecoder().decode(HistoryRecord.self, from: Data(json.utf8))
  }

  @Test func userMessageWithInboxIds() throws {
    let decoded = try record(
      """
      {"id":"rec-1","parentId":null,"timestamp":"2026-09-17T10:00:00.000Z","type":"message",
       "role":"user","overflow":{"raw":true},"inboxMessageIds":["11111111-1111-4111-8111-111111111111"],
       "content":[{"type":"text","text":"hello"}]}
      """)
    guard case .message(let message) = decoded.body else {
      Issue.record("expected message")
      return
    }
    #expect(message.role == .user)
    #expect(message.content == [.text("hello")])
    #expect(message.inboxMessageIds == ["11111111-1111-4111-8111-111111111111"])
  }

  @Test func assistantMessageWithToolCallAndFailure() throws {
    let decoded = try record(
      """
      {"id":"rec-2","parentId":"rec-1","timestamp":"2026-09-17T10:00:01.000Z",
       "type":"message","role":"assistant","overflow":{},"finishReason":"error",
       "failure":{"message":"provider closed the stream","diagnostics":["429"]},
       "content":[{"type":"reasoning","text":"thinking"},
        {"type":"tool_call","callId":"call-1","name":"read_file","arguments":{"path":"a"}}]}
      """)
    guard case .message(let message) = decoded.body else {
      Issue.record("expected message")
      return
    }
    #expect(message.role == .assistant)
    #expect(
      message.content == [.reasoning("thinking"), .toolCall(callId: "call-1", name: "read_file")])
    #expect(message.failure == "provider closed the stream")
  }

  @Test func toolResultRecord() throws {
    let decoded = try record(
      """
      {"id":"rec-3","parentId":"rec-2","timestamp":"2026-09-17T10:00:02.000Z",
       "type":"message","role":"tool","overflow":{},
       "content":[{"type":"tool_result","callId":"call-1","isError":true,
        "patch":"--- a\\n+++ b\\n","content":[{"type":"text","text":"missing"}]}]}
      """)
    guard case .message(let message) = decoded.body else {
      Issue.record("expected message")
      return
    }
    #expect(message.content == [.toolResult(callId: "call-1", isError: true)])
  }

  @Test func shellEventRecord() throws {
    let decoded = try record(
      """
      {"id":"rec-4","parentId":"rec-3","timestamp":"2026-09-17T10:00:03.000Z","type":"event",
       "eventType":"pi.bash_execution","overflow":{},
       "shell":{"command":"ls -la","output":"total 0\\n","exitCode":0,"cancelled":false,
        "truncated":false,"excludeFromContext":false}}
      """)
    guard case .event(let event) = decoded.body else {
      Issue.record("expected event")
      return
    }
    #expect(event.eventType == "pi.bash_execution")
    #expect(event.shell == ShellExecution(command: "ls -la", output: "total 0\n"))
  }

  @Test func displayedCustomMessageRecord() throws {
    let decoded = try record(
      """
      {"id":"rec-5","parentId":"rec-4","timestamp":"2026-09-17T10:00:04.000Z","type":"event",
       "eventType":"pi.custom_message","overflow":{},
       "custom":{"customType":"pi-orb.host-restarted","display":true},
       "content":[{"type":"text","text":"The host was restarted."}]}
      """)
    guard case .event(let event) = decoded.body else {
      Issue.record("expected event")
      return
    }
    #expect(event.custom == CustomMessage(customType: "pi-orb.host-restarted", display: true))
  }

  @Test func compactionRecord() throws {
    let decoded = try record(
      """
      {"id":"rec-6","parentId":"rec-5","timestamp":"2026-09-17T10:00:05.000Z",
       "type":"compaction","overflow":{},"summary":[{"type":"text","text":"summary"}]}
      """)
    #expect(decoded.body == .compaction)
  }

  @Test func unknownRecordTypeDecodesToOther() throws {
    let decoded = try record(
      """
      {"id":"rec-7","parentId":"rec-6","timestamp":"2026-09-17T10:00:06.000Z",
       "type":"checkpoint","overflow":{}}
      """)
    #expect(decoded.body == .other)
  }
}

@Suite("client frame encoding")
struct ClientFrameEncodingTests {
  private func encode(_ frame: ClientFrame) throws -> [String: Any] {
    let data = try JSONEncoder().encode(frame)
    return try #require(
      JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @Test func helloSendsExplicitNullCursor() throws {
    let object = try encode(.hello(clientInstanceId: "client-1", afterRecordId: nil))
    #expect(object["type"] as? String == "client.hello")
    #expect(object["v"] as? Int == 1)
    #expect(object["clientInstanceId"] as? String == "client-1")
    #expect(object["afterRecordId"] is NSNull)
  }

  @Test func helloCarriesCursor() throws {
    let object = try encode(.hello(clientInstanceId: "client-1", afterRecordId: "rec-3"))
    #expect(object["afterRecordId"] as? String == "rec-3")
  }

  @Test func presence() throws {
    let object = try encode(.presence(visible: true))
    #expect(object["type"] as? String == "client.presence")
    #expect(object["visible"] as? Bool == true)
  }
}
