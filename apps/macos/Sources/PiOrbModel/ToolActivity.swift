import Foundation

public enum ToolCategory: Sendable, Equatable {
  case edit
  case command
  case read
  case other(String)

  fileprivate var key: String {
    switch self {
    case .edit: "edit"
    case .command: "command"
    case .read: "read"
    case .other(let name): "other:\(name)"
    }
  }

  /// The word the collapsed row leads with.
  public var label: String {
    switch self {
    case .edit: "edit"
    case .command: "commands"
    case .read: "read"
    case .other(let name): name
    }
  }

  fileprivate init(toolName: String) {
    switch toolName {
    case "edit", "write": self = .edit
    case "bash": self = .command
    case "read": self = .read
    default: self = .other(toolName)
    }
  }
}

public struct DiffStats: Sendable, Equatable {
  public let added: Int
  public let removed: Int
}

/// One committed or live call, with whatever its result carried.
public struct ToolCall: Sendable, Equatable, Identifiable {
  public let callId: String
  public let name: String
  public let arguments: JSONValue?
  public let output: String
  public let patch: String?
  public let status: ToolStatus

  public var id: String { callId }

  public init(
    callId: String, name: String, arguments: JSONValue? = nil, output: String = "",
    patch: String? = nil, status: ToolStatus
  ) {
    self.callId = callId
    self.name = name
    self.arguments = arguments
    self.output = output
    self.patch = patch
    self.status = status
  }

  public var path: String? { arguments?["path"]?.stringValue }

  public var command: String { arguments?["command"]?.stringValue ?? name }

  /// A read names the window it took when the call asked for one.
  public var readLabel: String {
    let path = path ?? name
    let offset = arguments?["offset"]?.numberValue.map(Int.init)
    let limit = arguments?["limit"]?.numberValue.map(Int.init)
    if offset == nil && limit == nil { return path }
    let start = offset ?? 1
    guard let limit else { return "\(path):\(start)+" }
    return "\(path):\(start)–\(start + limit - 1)"
  }

  public var diff: DiffStats? { patch.map(diffStats(of:)) }
}

/// The lead metric of a collapsed row: either what an edit changed or how many
/// calls the run made.
public enum ToolMetric: Sendable, Equatable {
  case diff(DiffStats)
  case count(Int, noun: String)
}

/// One category of one maximal tool run, rendered as a single collapsed row.
public struct ToolGroup: Sendable, Equatable, Identifiable {
  public let id: String
  public let category: ToolCategory
  public let headline: String?
  public let metric: ToolMetric?
  public let trail: String?
  public let status: ToolStatus
  public let calls: [ToolCall]

  public var label: String { category.label }
}

/// Collapses one maximal run of adjacent tool calls into per-category rows,
/// ported from `apps/web/src/components/ToolActivity.tsx`. The run itself is cut
/// by visible prose; see `present(_:pending:)`.
public func toolGroups(runId: String, calls: [ToolCall]) -> [ToolGroup] {
  var order: [String] = []
  var byKey: [String: (category: ToolCategory, calls: [ToolCall])] = [:]
  for call in calls {
    let category = ToolCategory(toolName: call.name)
    if byKey[category.key] == nil {
      order.append(category.key)
      byKey[category.key] = (category, [])
    }
    byKey[category.key]?.calls.append(call)
  }
  return order.compactMap { key in
    guard let entry = byKey[key] else { return nil }
    return group(id: "\(runId)#\(key)", category: entry.category, calls: entry.calls)
  }
}

private func group(id: String, category: ToolCategory, calls: [ToolCall]) -> ToolGroup {
  let failed = calls.filter { $0.status == .failed }.count
  let running = calls.contains { $0.status == .running }
  return ToolGroup(
    id: id,
    category: category,
    headline: headline(category: category, calls: calls),
    metric: metric(category: category, calls: calls),
    trail: failed > 0 ? "\(failed) failed" : running ? "running" : nil,
    status: failed > 0 ? .failed : running ? .running : .completed,
    calls: calls)
}

/// A category of one names its file or command; larger runs count instead.
private func headline(category: ToolCategory, calls: [ToolCall]) -> String? {
  guard let first = calls.first else { return nil }
  switch category {
  case .edit: return calls.count == 1 ? first.path : nil
  case .command: return calls.count == 1 ? first.arguments?["command"]?.stringValue : nil
  case .read: return uniquePathCount(calls) == 1 ? first.path : nil
  case .other: return nil
  }
}

private func metric(category: ToolCategory, calls: [ToolCall]) -> ToolMetric? {
  if category == .edit, let stats = totalDiff(calls) { return .diff(stats) }
  let count =
    category == .edit || category == .read ? uniquePathCount(calls) : calls.count
  guard count >= 2 else { return nil }
  switch category {
  case .command: return .count(count, noun: "ran")
  case .other: return .count(count, noun: "calls")
  case .edit, .read: return .count(count, noun: "files")
  }
}

private func uniquePathCount(_ calls: [ToolCall]) -> Int {
  let paths = Set(calls.compactMap(\.path))
  return paths.isEmpty ? calls.count : paths.count
}

private func totalDiff(_ calls: [ToolCall]) -> DiffStats? {
  let stats = calls.compactMap(\.diff)
  guard !stats.isEmpty else { return nil }
  return DiffStats(
    added: stats.reduce(0) { $0 + $1.added }, removed: stats.reduce(0) { $0 + $1.removed })
}

private func diffStats(of patch: String) -> DiffStats {
  var added = 0
  var removed = 0
  for line in patch.split(separator: "\n", omittingEmptySubsequences: false) {
    if line.hasPrefix("+") && !line.hasPrefix("+++") { added += 1 }
    if line.hasPrefix("-") && !line.hasPrefix("---") { removed += 1 }
  }
  return DiffStats(added: added, removed: removed)
}
