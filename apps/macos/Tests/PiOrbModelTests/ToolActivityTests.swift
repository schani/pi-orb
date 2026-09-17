import Foundation
import Testing

@testable import PiOrbModel

/// Every tool group the state presents, in order.
func groups(_ state: TranscriptReducer.State) -> [ToolGroup] {
  present(state, pending: []).compactMap {
    if case .tools(let group) = $0.kind { return group }
    return nil
  }
}

private func frame(_ record: String) throws -> ServerFrame {
  try JSONDecoder().decode(
    ServerFrame.self,
    from: Data(
      """
      {"v":1,"type":"history.record","at":"2026-09-17T10:00:00.000Z","headId":null,
       "retiredBlockIds":[],"record":\(record)}
      """.utf8))
}

private func assistant(_ id: String, _ content: String) -> String {
  """
  {"id":"\(id)","parentId":null,"timestamp":"2026-09-17T10:00:00.000Z","type":"message",
   "role":"assistant","overflow":{},"content":[\(content)]}
  """
}

private func toolRecord(_ id: String, _ content: String) -> String {
  """
  {"id":"\(id)","parentId":null,"timestamp":"2026-09-17T10:00:01.000Z","type":"message",
   "role":"tool","overflow":{},"content":[\(content)]}
  """
}

private func bash(_ callId: String, _ command: String) -> String {
  """
  {"type":"tool_call","callId":"\(callId)","name":"bash","arguments":{"command":"\(command)"}}
  """
}

private func read(_ callId: String, _ path: String) -> String {
  """
  {"type":"tool_call","callId":"\(callId)","name":"read","arguments":{"path":"\(path)"}}
  """
}

private func result(_ callId: String, output: String = "", patch: String? = nil) -> String {
  let patchField = patch.map { ",\"patch\":\"\($0)\"" } ?? ""
  return """
    {"type":"tool_result","callId":"\(callId)","content":[{"type":"text","text":"\(output)"}]\
    \(patchField)}
    """
}

private func state(_ records: [String]) throws -> TranscriptReducer.State {
  var reducer = TranscriptReducer()
  for record in records { reducer.apply(try frame(record)) }
  return reducer.state
}

@Suite("tool activity")
struct ToolActivityTests {
  @Test func aRunOfFourCommandsCollapsesToOneGroup() throws {
    let rows = try state([
      assistant(
        "rec-1",
        [bash("c1", "npm ci"), bash("c2", "npm run check"), bash("c3", "git status"),
          bash("c4", "git diff")].joined(separator: ",")),
      toolRecord(
        "rec-2",
        ["c1", "c2", "c3", "c4"].map { result($0) }.joined(separator: ",")),
    ])
    let collapsed = groups(rows)
    #expect(collapsed.count == 1)
    #expect(collapsed[0].category == .command)
    #expect(collapsed[0].label == "commands")
    #expect(collapsed[0].headline == nil)
    #expect(collapsed[0].metric == .count(4, noun: "ran"))
    #expect(collapsed[0].status == .completed)
    #expect(collapsed[0].calls.map(\.callId) == ["c1", "c2", "c3", "c4"])
  }

  @Test func oneCommandLeadsWithItsCommandText() throws {
    let collapsed = try groups(state([assistant("rec-1", bash("c1", "npm ci"))]))
    #expect(collapsed.map(\.headline) == ["npm ci"])
    #expect(collapsed[0].metric == nil)
    #expect(collapsed[0].trail == "running")
    #expect(collapsed[0].status == .running)
  }

  @Test func threeReadsCollapseToTheirUniquePathCount() throws {
    let collapsed = try groups(
      state([
        assistant(
          "rec-1",
          [read("r1", "README.md"), read("r2", "API.md"), read("r3", "CLI.md"), read("r4", "API.md")]
            .joined(separator: ",")),
        toolRecord(
          "rec-2", ["r1", "r2", "r3", "r4"].map { result($0) }.joined(separator: ",")),
      ]))
    #expect(collapsed.count == 1)
    #expect(collapsed[0].category == .read)
    #expect(collapsed[0].headline == nil)
    #expect(collapsed[0].metric == .count(3, noun: "files"))
  }

  @Test func oneReadPathLeadsWithThatPath() throws {
    let collapsed = try groups(
      state([assistant("rec-1", [read("r1", "README.md"), read("r2", "README.md")].joined(separator: ","))]))
    #expect(collapsed.map(\.headline) == ["README.md"])
    #expect(collapsed[0].metric == nil)
  }

  @Test func readWindowsNameTheirRange() {
    let call = ToolCall(
      callId: "r1", name: "read",
      arguments: .object(["path": .string("a.ts"), "offset": .number(10), "limit": .number(5)]),
      status: .completed)
    #expect(call.readLabel == "a.ts:10–14")
  }

  @Test func anEditCountsItsPatchLines() throws {
    let collapsed = try groups(
      state([
        assistant(
          "rec-1",
          """
          {"type":"tool_call","callId":"e1","name":"edit","arguments":{"path":"src/a.ts"}}
          """),
        toolRecord(
          "rec-2",
          result("e1", patch: "--- a/src/a.ts\\n+++ b/src/a.ts\\n-old\\n+new\\n+extra")),
      ]))
    #expect(collapsed.count == 1)
    #expect(collapsed[0].category == .edit)
    #expect(collapsed[0].headline == "src/a.ts")
    #expect(collapsed[0].metric == .diff(DiffStats(added: 2, removed: 1)))
  }

  @Test func proseBetweenCallsBreaksTheRun() throws {
    let collapsed = try groups(
      state([
        assistant(
          "rec-1",
          [
            bash("c1", "npm ci"), bash("c2", "npm test"),
            "{\"type\":\"text\",\"text\":\"Now the gates.\"}",
            bash("c3", "git status"),
          ].joined(separator: ",")),
      ]))
    #expect(collapsed.count == 2)
    #expect(collapsed[0].calls.map(\.callId) == ["c1", "c2"])
    #expect(collapsed[1].calls.map(\.callId) == ["c3"])
    #expect(collapsed[0].id != collapsed[1].id)
  }

  @Test func differentCategoriesInOneRunStaySeparateRows() throws {
    let collapsed = try groups(
      state([
        assistant("rec-1", [bash("c1", "npm ci"), read("r1", "a.ts"), bash("c2", "npm test")].joined(separator: ",")),
      ]))
    #expect(collapsed.map(\.category) == [.command, .read])
    #expect(collapsed[0].calls.map(\.callId) == ["c1", "c2"])
  }

  @Test func unknownToolsKeepTheirOwnName() throws {
    let collapsed = try groups(
      state([
        assistant(
          "rec-1",
          """
          {"type":"tool_call","callId":"w1","name":"web_search","arguments":{"q":"swift"}}
          """),
      ]))
    #expect(collapsed.map(\.category) == [.other("web_search")])
    #expect(collapsed.map(\.label) == ["web_search"])
  }

  @Test func aFailedCallMarksItsGroup() throws {
    let collapsed = try groups(
      state([
        assistant("rec-1", [bash("c1", "npm ci"), bash("c2", "npm test")].joined(separator: ",")),
        toolRecord(
          "rec-2",
          [
            result("c1"),
            "{\"type\":\"tool_result\",\"callId\":\"c2\",\"isError\":true,\"content\":[]}",
          ].joined(separator: ",")),
      ]))
    #expect(collapsed[0].status == .failed)
    #expect(collapsed[0].trail == "1 failed")
  }

  @Test func aLiveChipForACommittedCallIsNotShownTwice() throws {
    var reducer = TranscriptReducer()
    reducer.apply(try frame(assistant("rec-1", bash("c1", "npm ci"))))
    for callId in ["c1", "c2"] {
      reducer.apply(
        try JSONDecoder().decode(
          ServerFrame.self,
          from: Data(
            """
            {"v":1,"type":"runtime.event","at":"2026-09-17T10:00:02.000Z",
             "event":{"type":"tool_state","operationId":"op-1","callId":"\(callId)",
              "name":"bash","revision":1,"state":"running"}}
            """.utf8)))
    }
    let collapsed = groups(reducer.state)
    #expect(collapsed.count == 2)
    #expect(collapsed[0].calls.map(\.callId) == ["c1"])
    #expect(collapsed[1].calls.map(\.callId) == ["c2"])
  }

  @Test func callsCarryTheirOutputForTheExpandedRow() throws {
    let collapsed = try groups(
      state([
        assistant("rec-1", bash("c1", "ls")),
        toolRecord("rec-2", result("c1", output: "a.ts")),
      ]))
    #expect(collapsed[0].calls.map(\.output) == ["a.ts"])
    #expect(collapsed[0].calls.map(\.command) == ["ls"])
  }
}
