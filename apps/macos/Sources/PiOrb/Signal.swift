import PiOrbModel
import SwiftUI

/// The web UI's Signal / Boards tokens (`apps/web/src/styles.css`): one 13px
/// monospace face on a 20px row, white ground, black ink, three greys, two
/// signal hues. Light only, as on the web.
enum Signal {
  static let w = Color.white
  static let k = Color.black
  static let g1 = Color(hex: 0xf2_f2f2)
  static let g2 = Color(hex: 0x999999)
  static let g3 = Color(hex: 0x555555)
  static let ok = Color(hex: 0x1a_7e37)
  static let bad = Color(hex: 0xb4_2318)

  static let mono = Font.system(size: 13, design: .monospaced)
  static let row: CGFloat = 20
  /// The macOS title bar height, which the top band of each pane fills.
  static let band: CGFloat = 28
  static let tracking: CGFloat = 13 * 0.08
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xff) / 255,
      green: Double((hex >> 8) & 0xff) / 255,
      blue: Double(hex & 0xff) / 255)
  }
}

/// The instrument tile of `apps/web/public/favicons/*.svg`: a 14px rounded
/// square in the state's hue carrying a white mark, drawn at 16px.
enum OrbGlyph {
  case busy, idle, start, stop, fail, arch, archng, del

  static func of(_ state: OrbState, _ activity: Activity?) -> OrbGlyph {
    switch state {
    case .running: activity == .busy ? .busy : .idle
    case .stopped: .stop
    case .failed: .fail
    case .archived: .arch
    case .archiving: .archng
    case .deleting: .del
    case .creating, .starting, .stopping: .start
    }
  }

  var hue: Color {
    switch self {
    case .busy, .idle: Signal.ok
    case .start, .archng: Color(hex: 0x96_6100)
    case .stop: Color(hex: 0x777777)
    case .fail, .del: Signal.bad
    case .arch: Color(hex: 0x666666)
    }
  }

  fileprivate var mark: Path {
    var path = Path()
    switch self {
    case .busy:
      for x in [5.0, 8.0, 11.0] {
        path.addEllipse(in: CGRect(x: x - 1, y: 7, width: 2, height: 2))
      }
    case .idle:
      path.addEllipse(in: CGRect(x: 5, y: 5, width: 6, height: 6))
    case .start:
      path.move(to: CGPoint(x: 5, y: 4))
      path.addLines([
        CGPoint(x: 11, y: 4), CGPoint(x: 11, y: 5), CGPoint(x: 5, y: 11), CGPoint(x: 5, y: 12),
        CGPoint(x: 11, y: 12), CGPoint(x: 11, y: 11), CGPoint(x: 5, y: 5),
      ])
      path.closeSubpath()
    case .stop:
      path.move(to: CGPoint(x: 5, y: 8))
      path.addLine(to: CGPoint(x: 11, y: 8))
    case .fail:
      path.move(to: CGPoint(x: 5, y: 5))
      path.addLine(to: CGPoint(x: 11, y: 11))
      path.move(to: CGPoint(x: 11, y: 5))
      path.addLine(to: CGPoint(x: 5, y: 11))
    case .arch:
      path.addRect(CGRect(x: 5, y: 5, width: 6, height: 6))
      path.move(to: CGPoint(x: 5, y: 7))
      path.addLine(to: CGPoint(x: 11, y: 7))
    case .archng:
      path.move(to: CGPoint(x: 8, y: 4))
      path.addLine(to: CGPoint(x: 8, y: 11))
      path.move(to: CGPoint(x: 5, y: 8))
      path.addLines([CGPoint(x: 8, y: 11), CGPoint(x: 11, y: 8)])
    case .del:
      path.move(to: CGPoint(x: 4, y: 5))
      path.addLine(to: CGPoint(x: 12, y: 5))
      path.move(to: CGPoint(x: 7, y: 3))
      path.addLine(to: CGPoint(x: 9, y: 3))
      path.move(to: CGPoint(x: 5, y: 5))
      path.addLines([CGPoint(x: 5, y: 12), CGPoint(x: 11, y: 12), CGPoint(x: 11, y: 5)])
      path.move(to: CGPoint(x: 8, y: 7))
      path.addLine(to: CGPoint(x: 8, y: 10))
    }
    return path
  }

  fileprivate var filled: Bool { self == .busy }
}

struct StateTile: View {
  let glyph: OrbGlyph
  let label: String

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 2).fill(glyph.hue).frame(width: 14, height: 14)
      if glyph.filled {
        MarkShape(path: glyph.mark).fill(.white)
      } else {
        MarkShape(path: glyph.mark)
          .stroke(.white, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
      }
    }
    .frame(width: 16, height: 16)
    .accessibilityLabel(label)
    .help(label)
  }
}

private struct MarkShape: Shape {
  let path: Path

  func path(in rect: CGRect) -> Path { path }
}

/// The web's boxed text button: 1px black border, inverting on hover and press,
/// dimmed to `--g2` when disabled.
struct SignalButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  @State private var hovering = false

  func makeBody(configuration: Configuration) -> some View {
    let inverted = enabled && (hovering || configuration.isPressed)
    return configuration.label
      .font(Signal.mono)
      .padding(.horizontal, 8)
      .frame(height: 18)
      .foregroundStyle(inverted ? Signal.w : enabled ? Signal.k : Signal.g2)
      .background(inverted ? Signal.k : Signal.w)
      .overlay(Rectangle().strokeBorder(enabled ? Signal.k : Signal.g2, lineWidth: 1))
      .onHover { hovering = $0 }
  }
}

/// The web's icon-only action: a 20px hit area holding a 16px glyph in `--g3`,
/// inverting on hover and dimmed to `--g2` when disabled.
struct IconButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  @State private var hovering = false

  func makeBody(configuration: Configuration) -> some View {
    let inverted = enabled && (hovering || configuration.isPressed)
    return configuration.label
      .frame(width: 20, height: 20)
      .foregroundStyle(inverted ? Signal.w : enabled ? Signal.g3 : Signal.g2)
      .background(inverted ? Signal.k : .clear)
      .onHover { hovering = $0 }
  }
}

/// The composer's send mark from `apps/web/src/components/Icons.tsx`.
struct SendIcon: View {
  var body: some View {
    MarkShape(
      path: {
        var path = Path()
        path.move(to: CGPoint(x: 8, y: 13))
        path.addLine(to: CGPoint(x: 8, y: 3))
        path.move(to: CGPoint(x: 3, y: 8))
        path.addLines([CGPoint(x: 8, y: 3), CGPoint(x: 13, y: 8)])
        return path
      }()
    )
    .stroke(style: StrokeStyle(lineWidth: 1.5, lineCap: .square))
    .frame(width: 16, height: 16)
  }
}

/// Every text field is black on white, inverting to white on black while
/// focused (`docs/web-ui.md`, text-field focus inversion).
struct InvertingField: View {
  let text: Binding<String>
  var bordered = true
  let onSubmit: () -> Void

  @FocusState private var focused: Bool

  var body: some View {
    TextField("", text: text, axis: .vertical)
      .textFieldStyle(.plain)
      .lineLimit(4...12)
      .font(Signal.mono)
      .focused($focused)
      .onSubmit(onSubmit)
      .foregroundStyle(focused ? Signal.w : Signal.k)
      .tint(focused ? Signal.w : Signal.k)
      .padding(.horizontal, bordered ? 6 : 0)
      .background(focused ? Signal.k : Signal.w)
      .overlay(bordered ? Rectangle().strokeBorder(Signal.k, lineWidth: 1) : nil)
  }
}

struct BandRule: View {
  var color: Color = Signal.k

  var body: some View {
    Rectangle().fill(color).frame(height: 1)
  }
}
