import Foundation

public struct ProjectView: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
}

public enum OrbState: String, Decodable, Sendable, Equatable {
  case creating, starting, running, stopping, stopped, failed, deleting, archiving, archived
}

public struct OrbView: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let projectId: String
  public let name: String?
  public let state: OrbState
  public let activity: Activity?

  public var title: String { name ?? id }
}

public struct SessionMetadata: Decodable, Sendable, Equatable {
  public let id: String
}

public struct OrbHistoryView: Decodable, Sendable, Equatable {
  public let session: SessionMetadata?
  public let headId: String?
  public let records: [HistoryRecord]

  public init(session: SessionMetadata?, headId: String?, records: [HistoryRecord]) {
    self.session = session
    self.headId = headId
    self.records = records
  }
}

public enum ApiError: Error, Equatable {
  case transport(String)
  case status(Int, String)
  case decoding(String)
}

/// Adapter boundary for the control-plane HTTP API. Every `URLSession`,
/// decoding, or HTTP status failure is mapped to `ApiError` here.
public struct ControlPlaneClient: Sendable {
  public static let defaultBaseURL = URL(string: "http://127.0.0.1:7100")!

  public let baseURL: URL
  private let session: URLSession

  public init(baseURL: URL = ControlPlaneClient.defaultBaseURL, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.session = session
  }

  /// `PI_ORB_BASE_URL`, falling back to the local control plane.
  public static func fromEnvironment(
    _ environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> ControlPlaneClient {
    let raw = environment["PI_ORB_BASE_URL"] ?? ""
    return ControlPlaneClient(baseURL: URL(string: raw) ?? defaultBaseURL)
  }

  public func projects() async throws(ApiError) -> [ProjectView] {
    try await list("api/v1/projects")
  }

  public func orbs(projectId: String) async throws(ApiError) -> [OrbView] {
    try await list("api/v1/projects/\(escape(projectId))/orbs")
  }

  public func history(orbId: String) async throws(ApiError) -> OrbHistoryView {
    try await request("api/v1/orbs/\(escape(orbId))/history", method: "GET", body: nil)
  }

  public func start(orbId: String) async throws(ApiError) {
    _ = try await send("api/v1/orbs/\(escape(orbId))/start", method: "POST", body: nil)
  }

  public func stop(orbId: String) async throws(ApiError) {
    _ = try await send("api/v1/orbs/\(escape(orbId))/stop", method: "POST", body: nil)
  }

  /// Durable send-anytime inbox: works for stopped and running orbs alike.
  public func enqueueMessage(
    orbId: String, messageId: String, text: String
  ) async throws(ApiError) {
    let body = try encode(["content": [["type": "text", "text": text]]])
    _ = try await send(
      "api/v1/orbs/\(escape(orbId))/messages/\(escape(messageId))", method: "PUT", body: body)
  }

  public func liveURL(orbId: String) -> URL {
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
    let base = components?.url ?? baseURL
    return base.appendingPathComponent("api/v1/orbs/\(orbId)/live")
  }

  private struct ListResponse<Item: Decodable & Sendable>: Decodable {
    let items: [Item]
  }

  private func list<Item: Decodable & Sendable>(_ path: String) async throws(ApiError) -> [Item] {
    let response: ListResponse<Item> = try await request(path, method: "GET", body: nil)
    return response.items
  }

  private func request<Value: Decodable & Sendable>(
    _ path: String, method: String, body: Data?
  ) async throws(ApiError) -> Value {
    let data = try await send(path, method: method, body: body)
    do {
      return try JSONDecoder().decode(Value.self, from: data)
    } catch {
      throw ApiError.decoding(String(describing: error))
    }
  }

  private func send(_ path: String, method: String, body: Data?) async throws(ApiError) -> Data {
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = method
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw ApiError.transport(error.localizedDescription)
    }
    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(code) else {
      throw ApiError.status(code, describe(data))
    }
    return data
  }

  private func encode(_ value: [String: [[String: String]]]) throws(ApiError) -> Data {
    do {
      return try JSONEncoder().encode(value)
    } catch {
      throw ApiError.decoding(String(describing: error))
    }
  }

  private func escape(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
  }
}

private struct HttpErrorBody: Decodable {
  struct Body: Decodable {
    let message: String
  }
  let error: Body
}

private func describe(_ data: Data) -> String {
  if let decoded = try? JSONDecoder().decode(HttpErrorBody.self, from: data) {
    return decoded.error.message
  }
  return String(data: data, encoding: .utf8) ?? ""
}
