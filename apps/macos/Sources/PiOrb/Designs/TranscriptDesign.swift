import PiOrbModel
import SwiftUI

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
