import PiOrbModel
import SwiftUI

/// Shared vocabulary for the collapsed tool rows every design draws.
enum ToolPresentation {
  /// The web caps a call's raw input at 200 characters.
  static let argumentsLimit = 200

  static func symbol(_ category: ToolCategory) -> String {
    switch category {
    case .edit: "pencil"
    case .command: "terminal"
    case .read: "doc.text"
    case .other: "wrench.and.screwdriver"
    }
  }

  static func mark(_ status: ToolStatus) -> String {
    switch status {
    case .running: "circle.dotted"
    case .completed: "checkmark"
    case .failed: "xmark"
    }
  }

  static func glyph(_ status: ToolStatus) -> String {
    switch status {
    case .running: "◐"
    case .completed: "✓"
    case .failed: "✕"
    }
  }

  static func metric(_ group: ToolGroup) -> String? {
    switch group.metric {
    case .diff(let stats): "+\(stats.added) −\(stats.removed)"
    case .count(let count, let noun): "\(count) \(noun)"
    case nil: nil
    }
  }

  /// Lead metric and trailing state, joined the way the web's rail row is.
  static func metricLine(_ group: ToolGroup) -> String? {
    [metric(group), group.trail].compactMap { $0 }.joined(separator: " · ").nonEmpty
  }

  static func title(_ call: ToolCall, in category: ToolCategory) -> String {
    switch category {
    case .command: call.command
    case .read: call.readLabel
    case .edit: call.path ?? call.name
    case .other: call.name
    }
  }

  static func detail(_ call: ToolCall, in category: ToolCategory) -> String {
    let input = call.arguments.map { truncate($0.prettyPrinted) } ?? ""
    switch category {
    case .command:
      return call.output
    case .edit, .read:
      return call.output.isEmpty ? input : call.output
    case .other:
      return [input, call.output].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
  }

  static func truncate(_ text: String) -> String {
    text.count > argumentsLimit ? "\(text.prefix(argumentsLimit))…" : text
  }
}

extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}

/// The expanded body of a tool group: one entry per call with its argument and
/// its result text.
struct ToolCallsView: View {
  let group: ToolGroup
  let mono: Font
  let secondary: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(group.calls) { call in
        VStack(alignment: .leading, spacing: 2) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(ToolPresentation.glyph(call.status))
            Text(ToolPresentation.title(call, in: group.category))
              .lineLimit(2)
            Spacer(minLength: 0)
            if let diff = call.diff {
              Text("+\(diff.added) −\(diff.removed)")
            }
          }
          .font(mono)
          let detail = ToolPresentation.detail(call, in: group.category)
          if !detail.isEmpty {
            Text(detail)
              .font(mono)
              .foregroundStyle(secondary)
              .lineLimit(12)
              .textSelection(.enabled)
          }
        }
      }
    }
  }
}
