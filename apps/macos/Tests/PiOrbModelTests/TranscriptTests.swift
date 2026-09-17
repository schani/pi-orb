import Foundation
import Testing

@testable import PiOrbModel

private func decode(_ json: String) throws -> ServerFrame {
  try JSONDecoder().decode(ServerFrame.self, from: Data(json.utf8))
}

private func userRecord(_ id: String, _ text: String, inbox: [String] = []) -> String {
  let ids = inbox.map { "\"\($0)\"" }.joined(separator: ",")
  return """
    {"id":"\(id)","parentId":null,"timestamp":"2026-09-17T10:00:00.000Z","type":"message",
     "role":"user","overflow":{},"inboxMessageIds":[\(ids)],
     "content":[{"type":"text","text":"\(text)"}]}
    """
}

private func historyFrame(_ record: String, retired: [String] = []) -> String {
  let ids = retired.map { "\"\($0)\"" }.joined(separator: ",")
  return """
    {"v":1,"type":"history.record","at":"2026-09-17T10:00:00.000Z","headId":null,
     "retiredBlockIds":[\(ids)],"record":\(record)}
    """
}

@Suite("transcript reducer")
struct TranscriptReducerTests {
  @Test func scriptedSession() throws {
    var reducer = TranscriptReducer()
    let script = [
      """
      {"v":1,"type":"server.welcome","at":"2026-09-17T10:00:00.000Z","connectionId":"c1",
       "runtimeInstanceId":"rt-1","orbId":"orb-1","sessionId":"sess-1","capabilities":[],
       "limits":{"maxIncomingFrameBytes":1048576,"maxPromptBytes":262144}}
      """,
      """
      {"v":1,"type":"sync.started","at":"2026-09-17T10:00:00.000Z","mode":"full",
       "afterRecordId":null}
      """,
      historyFrame(userRecord("rec-1", "first")),
      historyFrame(
        """
        {"id":"rec-2","parentId":"rec-1","timestamp":"2026-09-17T10:00:01.000Z",
         "type":"message","role":"assistant","overflow":{},
         "content":[{"type":"text","text":"answer"},
          {"type":"tool_call","callId":"call-1","name":"read_file","arguments":{}}]}
        """),
      historyFrame(
        """
        {"id":"rec-3","parentId":"rec-2","timestamp":"2026-09-17T10:00:02.000Z",
         "type":"event","eventType":"pi.bash_execution","overflow":{},
         "shell":{"command":"ls","output":"a\\n","exitCode":0,"cancelled":false,
          "truncated":false,"excludeFromContext":false}}
        """),
      """
      {"v":1,"type":"sync.completed","at":"2026-09-17T10:00:02.000Z","headId":"rec-3"}
      """,
      """
      {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:03.000Z",
       "event":{"type":"operation_started","operationId":"op-1"}}
      """,
      """
      {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:04.000Z",
       "event":{"type":"output_patch","operationId":"op-1","blockId":"block-1",
        "blockType":"text","revision":1,"patch":{"type":"append","text":"par"}}}
      """,
      """
      {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:05.000Z",
       "event":{"type":"output_patch","operationId":"op-1","blockId":"block-1",
        "blockType":"text","revision":2,"patch":{"type":"replace","text":"partial answer"}}}
      """,
      """
      {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:06.000Z",
       "event":{"type":"tool_state","operationId":"op-1","callId":"call-2","name":"edit_file",
        "revision":1,"state":"running"}}
      """,
    ]
    for json in script { reducer.apply(try decode(json)) }

    #expect(reducer.state.sessionId == "sess-1")
    #expect(reducer.state.records.map(\.id) == ["rec-1", "rec-2", "rec-3"])
    #expect(reducer.state.synced)
    #expect(reducer.state.activity == .busy)
    #expect(reducer.state.liveBlocks.map(\.text) == ["partial answer"])
    #expect(
      reducer.state.liveTools
        == [LiveTool(callId: "call-2", name: "edit_file", status: .running)])

    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-4","parentId":"rec-3","timestamp":"2026-09-17T10:00:07.000Z",
           "type":"message","role":"assistant","overflow":{},
           "content":[{"type":"text","text":"partial answer"}]}
          """, retired: ["block-1"])))
    #expect(reducer.state.liveBlocks.isEmpty)
    #expect(reducer.state.records.map(\.id) == ["rec-1", "rec-2", "rec-3", "rec-4"])

    reducer.apply(
      try decode(
        """
        {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:08.000Z",
         "event":{"type":"operation_finished","operationId":"op-1","outcome":"completed"}}
        """))
    #expect(reducer.state.liveBlocks.isEmpty)
    #expect(reducer.state.liveTools.isEmpty)
    #expect(reducer.state.activity == .idle)
    #expect(reducer.state.error == nil)
    #expect(reducer.state.afterRecordId == "rec-4")
  }

  @Test func upsertKeepsInsertionOrder() throws {
    var reducer = TranscriptReducer()
    reducer.apply(try decode(historyFrame(userRecord("rec-1", "one"))))
    reducer.apply(try decode(historyFrame(userRecord("rec-2", "two"))))
    reducer.apply(try decode(historyFrame(userRecord("rec-1", "one revised"))))
    #expect(reducer.state.records.map(\.id) == ["rec-1", "rec-2"])
    #expect(present(reducer.state, pending: []).map(\.kind).first == .userText("one revised"))
  }

  @Test func fullSyncClearsRecordsAndAfterSyncDoesNot() throws {
    var reducer = TranscriptReducer()
    reducer.apply(try decode(historyFrame(userRecord("rec-1", "one"))))
    reducer.apply(
      try decode(
        """
        {"v":1,"type":"sync.started","at":"2026-09-17T10:00:00.000Z","mode":"after",
         "afterRecordId":"rec-1"}
        """))
    #expect(reducer.state.records.count == 1)
    reducer.apply(
      try decode(
        """
        {"v":1,"type":"sync.started","at":"2026-09-17T10:00:00.000Z","mode":"full",
         "afterRecordId":null}
        """))
    #expect(reducer.state.records.isEmpty)
  }

  @Test func unknownFramesAndEventsAreIgnored() throws {
    var reducer = TranscriptReducer()
    reducer.apply(try decode(historyFrame(userRecord("rec-1", "one"))))
    let before = reducer.state
    reducer.apply(
      try decode(
        """
        {"v":1,"type":"server.telemetry","at":"2026-09-17T10:00:00.000Z"}
        """))
    reducer.apply(
      try decode(
        """
        {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:00.000Z",
         "event":{"type":"cost_update","costUsd":1}}
        """))
    #expect(reducer.state == before)
  }

  @Test func historyLoadSeedsRecords() throws {
    let view = try JSONDecoder().decode(
      OrbHistoryView.self,
      from: Data(
        """
        {"orbId":"orb-1","cursor":"rec-1","headId":"rec-1",
         "session":{"id":"sess-1","overflow":{}},
         "records":[\(userRecord("rec-1", "loaded"))]}
        """.utf8))
    var reducer = TranscriptReducer()
    reducer.load(view)
    #expect(reducer.state.afterRecordId == "rec-1")
    #expect(reducer.state.sessionId == "sess-1")
  }
}

@Suite("transcript presentation")
struct TranscriptPresentationTests {
  private let inboxId = "11111111-1111-4111-8111-111111111111"

  @Test func pendingMessageSurvivesUntilItsRecordArrives() throws {
    var reducer = TranscriptReducer()
    let pending = [PendingMessage(id: inboxId, text: "queued work")]
    #expect(
      present(reducer.state, pending: pending).map(\.kind) == [.pending("queued work")])

    reducer.apply(try decode(historyFrame(userRecord("rec-1", "queued work", inbox: [inboxId]))))
    #expect(
      present(reducer.state, pending: pending).map(\.kind) == [.userText("queued work")])
  }

  @Test func unrelatedRecordDoesNotRetirePending() throws {
    var reducer = TranscriptReducer()
    reducer.apply(try decode(historyFrame(userRecord("rec-1", "other", inbox: ["other-id"]))))
    let rows = present(reducer.state, pending: [PendingMessage(id: inboxId, text: "mine")])
    #expect(rows.map(\.kind) == [.userText("other"), .pending("mine")])
  }

  @Test func toolCallsGainMarksFromLaterToolResults() throws {
    var reducer = TranscriptReducer()
    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-1","parentId":null,"timestamp":"2026-09-17T10:00:00.000Z",
           "type":"message","role":"assistant","overflow":{},
           "content":[{"type":"tool_call","callId":"call-1","name":"read_file","arguments":{}},
            {"type":"tool_call","callId":"call-2","name":"edit_file","arguments":{}}]}
          """)))
    #expect(
      present(reducer.state, pending: []).map(\.kind) == [
        .tool(name: "read_file", status: .running),
        .tool(name: "edit_file", status: .running),
      ])

    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-2","parentId":"rec-1","timestamp":"2026-09-17T10:00:01.000Z",
           "type":"message","role":"tool","overflow":{},
           "content":[{"type":"tool_result","callId":"call-1","content":[]},
            {"type":"tool_result","callId":"call-2","isError":true,"content":[]}]}
          """)))
    #expect(
      present(reducer.state, pending: []).map(\.kind) == [
        .tool(name: "read_file", status: .completed),
        .tool(name: "edit_file", status: .failed),
      ])
  }

  @Test func rendersShellAndDisplayedCustomMessagesOnly() throws {
    var reducer = TranscriptReducer()
    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-1","parentId":null,"timestamp":"2026-09-17T10:00:00.000Z",
           "type":"event","eventType":"pi.bash_execution","overflow":{},
           "shell":{"command":"ls","output":"a\\n","exitCode":0,"cancelled":false,
            "truncated":false,"excludeFromContext":false}}
          """)))
    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-2","parentId":"rec-1","timestamp":"2026-09-17T10:00:01.000Z",
           "type":"event","eventType":"pi.custom_message","overflow":{},
           "custom":{"customType":"pi-orb.boot","display":false},
           "content":[{"type":"text","text":"hidden"}]}
          """)))
    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-3","parentId":"rec-2","timestamp":"2026-09-17T10:00:02.000Z",
           "type":"event","eventType":"pi.custom_message","overflow":{},
           "custom":{"customType":"pi-orb.host-restarted","display":true},
           "content":[{"type":"text","text":"The host was restarted."}]}
          """)))
    #expect(
      present(reducer.state, pending: []).map(\.kind) == [
        .shell(command: "ls", output: "a\n"),
        .note("The host was restarted."),
      ])
  }

  @Test func omitsReasoningAndShowsLiveOutputLast() throws {
    var reducer = TranscriptReducer()
    reducer.apply(
      try decode(
        historyFrame(
          """
          {"id":"rec-1","parentId":null,"timestamp":"2026-09-17T10:00:00.000Z",
           "type":"message","role":"assistant","overflow":{},
           "content":[{"type":"reasoning","text":"private"},
            {"type":"text","text":"visible"}]}
          """)))
    reducer.apply(
      try decode(
        """
        {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:01.000Z",
         "event":{"type":"output_patch","operationId":"op-1","blockId":"block-1",
          "blockType":"reasoning","revision":1,"patch":{"type":"append","text":"hidden"}}}
        """))
    reducer.apply(
      try decode(
        """
        {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:02.000Z",
         "event":{"type":"output_patch","operationId":"op-1","blockId":"block-2",
          "blockType":"text","revision":1,"patch":{"type":"append","text":"streaming"}}}
        """))
    #expect(
      present(reducer.state, pending: []).map(\.kind) == [
        .assistantText("visible"), .live("streaming"),
      ])
  }
}
