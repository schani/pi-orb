import Foundation

public enum LiveStatus: Sendable, Equatable {
  case connecting
  case open
  case retrying
  case closed
}

public enum LiveEvent: Sendable, Equatable {
  case status(LiveStatus)
  case frame(ServerFrame)
}

/// One orb's live channel: hello handshake, frame decoding, and a fixed
/// two-second reconnect backoff. Unparseable or unknown frames are ignored,
/// never fatal.
@MainActor
public final class LiveConnection {
  private let url: URL
  private let session: URLSession
  private let clientInstanceId = UUID().uuidString
  private let afterRecordId: () -> String?
  private let onEvent: (LiveEvent) -> Void
  private var task: URLSessionWebSocketTask?
  private var loop: Task<Void, Never>?

  private static let retryDelay = Duration.seconds(2)

  public init(
    url: URL,
    session: URLSession = .shared,
    afterRecordId: @escaping () -> String?,
    onEvent: @escaping (LiveEvent) -> Void
  ) {
    self.url = url
    self.session = session
    self.afterRecordId = afterRecordId
    self.onEvent = onEvent
  }

  public func start() {
    guard loop == nil else { return }
    loop = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.runOnce()
        if Task.isCancelled { return }
        self.onEvent(.status(.retrying))
        try? await Task.sleep(for: LiveConnection.retryDelay)
      }
    }
  }

  public func stop() {
    loop?.cancel()
    loop = nil
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    onEvent(.status(.closed))
  }

  deinit {
    loop?.cancel()
  }

  private func runOnce() async {
    onEvent(.status(.connecting))
    var request = URLRequest(url: url)
    request.setValue(runtimeSubprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
    let socket = session.webSocketTask(with: request)
    task = socket
    socket.resume()

    guard
      await sendFrame(
        socket, .hello(clientInstanceId: clientInstanceId, afterRecordId: afterRecordId()))
    else { return }
    // Consumed by the control plane for idle auto-stop (docs/lifecycle.md);
    // a connection that never reports visibility counts as hidden.
    _ = await sendFrame(socket, .presence(visible: true))
    onEvent(.status(.open))

    while !Task.isCancelled {
      let message: URLSessionWebSocketTask.Message
      do {
        message = try await socket.receive()
      } catch {
        break
      }
      guard case .string(let text) = message, let data = text.data(using: .utf8) else {
        continue
      }
      guard let frame = try? JSONDecoder().decode(ServerFrame.self, from: data) else {
        continue
      }
      onEvent(.frame(frame))
    }
    socket.cancel(with: .goingAway, reason: nil)
    if task === socket { task = nil }
  }

  private func sendFrame(_ socket: URLSessionWebSocketTask, _ frame: ClientFrame) async -> Bool {
    guard let data = try? JSONEncoder().encode(frame),
      let text = String(data: data, encoding: .utf8)
    else { return false }
    do {
      try await socket.send(.string(text))
      return true
    } catch {
      return false
    }
  }
}
