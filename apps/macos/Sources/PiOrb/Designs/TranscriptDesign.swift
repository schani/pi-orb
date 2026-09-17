import PiOrbModel
import SwiftUI

/// The five transcript directions under comparison. `View › Design` switches
/// between them and `UserDefaults` remembers the choice.
enum TranscriptDesign: String, CaseIterable, Identifiable {
  case paper
  case terminal
  case native
  case bands
  case ledger

  static let storageKey = "transcriptDesign"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .paper: "Paper"
    case .terminal: "Terminal"
    case .native: "Native"
    case .bands: "Inverted bands"
    case .ledger: "Ledger"
    }
  }
}

/// Everything a design draws: the presented rows and the composer it writes to.
struct TranscriptContext {
  let rows: [TranscriptRow]
  let busy: Bool
  let error: String?
  let draft: Binding<String>
  let send: () -> Void

  var trimmedDraft: String {
    draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

struct TranscriptSurface: View {
  let design: TranscriptDesign
  let context: TranscriptContext

  var body: some View {
    switch design {
    case .paper: PaperTranscript(context: context)
    case .terminal: TerminalTranscript(context: context)
    case .native: NativeTranscript(context: context)
    case .bands: BandsTranscript(context: context)
    case .ledger: LedgerTranscript(context: context)
    }
  }
}

/// Bottom-pinned scrolling, shared by every design.
struct TranscriptScroll<Content: View>: View {
  let lastRowId: String?
  @ViewBuilder let content: Content

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        content.frame(maxWidth: .infinity, alignment: .leading)
      }
      .onChange(of: lastRowId) { _, last in
        guard let last else { return }
        withAnimation { proxy.scrollTo(last, anchor: .bottom) }
      }
    }
  }
}
