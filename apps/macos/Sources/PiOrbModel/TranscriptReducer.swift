import Foundation

public struct LiveBlock: Sendable, Equatable {
  public let blockId: String
  public let blockType: LiveBlockType
  public var text: String
}

public struct LiveTool: Sendable, Equatable {
  public let callId: String
  public var name: String
  public var status: ToolStatus
}

/// Pure projection of the history load plus the live frame stream.
public struct TranscriptReducer: Sendable {
  public struct State: Sendable, Equatable {
    public private(set) var records: [HistoryRecord] = []
    public private(set) var liveBlocks: [LiveBlock] = []
    public private(set) var liveTools: [LiveTool] = []
    public private(set) var sessionId: String?
    public private(set) var activity: Activity?
    public private(set) var synced = false
    public private(set) var error: String?

    private var recordIndex: [String: Int] = [:]

    public init() {}

    /// The last applied record id, sent as `afterRecordId` on (re)connect.
    public var afterRecordId: String? { records.last?.id }

    fileprivate mutating func upsert(_ record: HistoryRecord) {
      if let index = recordIndex[record.id] {
        records[index] = record
      } else {
        recordIndex[record.id] = records.count
        records.append(record)
      }
    }

    fileprivate mutating func clearRecords() {
      records = []
      recordIndex = [:]
    }

    fileprivate mutating func clearLive() {
      liveBlocks = []
      liveTools = []
    }

    fileprivate mutating func clearTransient() {
      clearLive()
      activity = nil
      synced = false
    }

    fileprivate mutating func retire(_ blockIds: [String]) {
      guard !blockIds.isEmpty else { return }
      liveBlocks.removeAll { blockIds.contains($0.blockId) }
    }

    fileprivate mutating func patch(_ patch: OutputPatch) {
      if let index = liveBlocks.firstIndex(where: { $0.blockId == patch.blockId }) {
        liveBlocks[index].text =
          patch.append ? liveBlocks[index].text + patch.text : patch.text
      } else {
        liveBlocks.append(
          LiveBlock(
            blockId: patch.blockId, blockType: patch.blockType, text: patch.text))
      }
    }

    fileprivate mutating func tool(_ change: ToolStateChange) {
      if let index = liveTools.firstIndex(where: { $0.callId == change.callId }) {
        liveTools[index].name = change.name
        liveTools[index].status = change.status
      } else {
        liveTools.append(
          LiveTool(callId: change.callId, name: change.name, status: change.status))
      }
    }

    fileprivate mutating func setSession(_ id: String) {
      if sessionId != nil && sessionId != id { clearRecords() }
      sessionId = id
    }

    fileprivate mutating func setActivity(_ value: Activity) { activity = value }
    fileprivate mutating func setSynced() { synced = true }
    fileprivate mutating func setError(_ value: String?) { error = value }
  }

  public private(set) var state = State()

  public init() {}

  /// Replaces the transcript with a history load from the control plane.
  public mutating func load(_ view: OrbHistoryView) {
    state = State()
    state.setSession(view.session?.id ?? "")
    for record in view.records { state.upsert(record) }
  }

  public mutating func apply(_ frame: ServerFrame) {
    switch frame {
    case .welcome(let welcome):
      state.setSession(welcome.sessionId)
      state.setError(nil)
    case .syncStarted(let mode):
      state.clearTransient()
      if mode == .full { state.clearRecords() }
    case .historyRecord(let record, let retiredBlockIds, _):
      state.upsert(record)
      state.retire(retiredBlockIds)
    case .syncCompleted:
      state.setSynced()
    case .runtimeEvent(let event):
      apply(event)
    case .requestRejected(let message):
      state.setError(message)
    case .serverError(_, let message):
      state.setError(message)
    case .requestAccepted, .unknown:
      break
    }
  }

  private mutating func apply(_ event: RuntimeEvent) {
    switch event {
    case .status(let activity, _):
      state.setActivity(activity)
    case .operationStarted:
      state.setActivity(.busy)
    case .outputPatch(let patch):
      state.patch(patch)
    case .toolState(let change):
      state.tool(change)
    case .operationFinished(_, let failure):
      state.clearLive()
      state.setActivity(.idle)
      if let failure { state.setError(failure) }
    case .unknown:
      break
    }
  }
}
