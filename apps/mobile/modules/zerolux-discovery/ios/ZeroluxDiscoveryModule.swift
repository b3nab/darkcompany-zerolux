import ExpoModulesCore
import Network

/// ZeroLux kernels announcing themselves on the local network (`_zerolux._tcp`): each one with
/// its TXT record and the address a connection to it reached, as it comes, changes or goes.
public class ZeroluxDiscoveryModule: Module {
  private var browser: NWBrowser?
  private var resolving: [String: NWConnection] = [:]

  public func definition() -> ModuleDefinition {
    Name("ZeroluxDiscovery")

    Events("found", "lost", "state")

    Function("start") {
      DispatchQueue.main.async { self.start() }
    }

    Function("stop") {
      DispatchQueue.main.async { self.stop() }
    }

    OnDestroy {
      DispatchQueue.main.async { self.stop() }
    }
  }

  private func start() {
    stop()
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: "_zerolux._tcp", domain: "local."),
      using: NWParameters()
    )
    browser.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        self?.sendEvent("state", ["state": "ready"])
      // Refused by the person, in Settings, Local Network: nothing can be found until allowed.
      case .waiting(let error), .failed(let error):
        self?.sendEvent("state", ["state": Self.denied(error) ? "denied" : "failed"])
      default:
        break
      }
    }
    browser.browseResultsChangedHandler = { [weak self] _, changes in
      for change in changes {
        switch change {
        case .added(let result), .changed(old: _, new: let result, flags: _):
          self?.resolve(result)
        case .removed(let result):
          if case let .service(name, _, _, _) = result.endpoint {
            self?.resolving.removeValue(forKey: name)?.cancel()
            self?.sendEvent("lost", ["service": name])
          }
        default:
          break
        }
      }
    }
    browser.start(queue: .main)
    self.browser = browser
  }

  private func stop() {
    browser?.cancel()
    browser = nil
    resolving.values.forEach { $0.cancel() }
    resolving.removeAll()
  }

  /// Where a found kernel is: Bonjour names a service, and a connection to it says the address
  /// it reached, which is also proof that the kernel can be reached from here. IPv4 first, an
  /// address a URL takes as it is; then any, for a network without it.
  private func resolve(_ result: NWBrowser.Result, ipv4: Bool = true) {
    guard case let .service(name, _, _, _) = result.endpoint else { return }
    var txt: [String: String] = [:]
    if case let .bonjour(record) = result.metadata {
      txt = record.dictionary
    }
    resolving.removeValue(forKey: name)?.cancel()
    let parameters = NWParameters.tcp
    if ipv4, let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
      ip.version = .v4
    }
    let connection = NWConnection(to: result.endpoint, using: parameters)
    resolving[name] = connection
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection else { return }
      switch state {
      case .ready:
        if case let .hostPort(host, port) = connection.currentPath?.remoteEndpoint,
          let address = Self.address(host)
        {
          self.sendEvent(
            "found",
            ["service": name, "txt": txt, "address": address, "port": Int(port.rawValue)]
          )
        }
        connection.cancel()
        if self.resolving[name] === connection { self.resolving[name] = nil }
      case .failed, .waiting:
        connection.cancel()
        if self.resolving[name] === connection {
          self.resolving[name] = nil
          if ipv4 { self.resolve(result, ipv4: false) }
        }
      default:
        break
      }
    }
    connection.start(queue: .main)
  }

  /// An address as a URL takes it: IPv4 as it is, IPv6 in brackets with its zone escaped.
  private static func address(_ host: NWEndpoint.Host) -> String? {
    switch host {
    case .ipv4(let ip):
      return "\(ip)"
    case .ipv6(let ip):
      return "[\("\(ip)".replacingOccurrences(of: "%", with: "%25"))]"
    case .name(let name, _):
      return name
    @unknown default:
      return nil
    }
  }

  private static func denied(_ error: NWError) -> Bool {
    if case let .dns(code) = error { return code == kDNSServiceErr_PolicyDenied }
    return false
  }
}
